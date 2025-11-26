import type { EntityManager } from 'typeorm';

import { ConflictException } from 'src/common/errors/api.exception';
import { DuplicateDisputeException } from 'src/common/errors/business.exceptions';
import { ChargeNotFoundException, DisputeNotFoundException } from 'src/common/errors/not-found.exceptions';
import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { EventPublisher } from 'src/events/publisher';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';
import { ChargeRepository } from 'src/payments/charge.repository';
import { DisputesService, EVIDENCE_WINDOW_DAYS } from 'src/disputes/disputes.service';
import { DisputeRepository } from 'src/disputes/dispute.repository';
import { DisputeEvidenceService } from 'src/disputes/dispute-evidence.service';
import { DisputeFeeService } from 'src/disputes/dispute-fee.service';
import { DisputeStateMachine } from 'src/disputes/state/dispute.state-machine';
import {
  DisputeEvidenceDto,
  SubmitDisputeEvidenceDto,
} from 'src/disputes/dto/submit-dispute-evidence.dto';

import { FixedClock } from 'test/support/fixed-clock';
import { makeSessionPrincipal } from 'test/factories/principal.factory';
import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The two things this service has to get right are both consequences of PAY-2041:
 *
 *  1. `openFromWebhook` inserts first and lets `uq_dispute_charge_open` decide. A check-then-act
 *     around a side effect — and a dispute posts a `chargeback_liability` leg, so this is a side
 *     effect — is the exact shape ADR 0011 forbids.
 *  2. `close` is the single emitter of `dispute.closed`. Three callers reach it (the network's
 *     verdict, the merchant's concession, the deadline job) and none of them may emit it
 *     themselves, or the console's dispute count double-counts.
 */
describe('DisputesService', () => {
  let disputes: jest.Mocked<DisputeRepository>;
  let charges: jest.Mocked<ChargeRepository>;
  let fees: jest.Mocked<DisputeFeeService>;
  let evidence: jest.Mocked<DisputeEvidenceService>;
  let ledger: jest.Mocked<LedgerReadThroughService>;
  let transactions: TransactionManager;
  let ids: jest.Mocked<IdFactory>;
  let events: jest.Mocked<EventPublisher>;
  let clock: FixedClock;
  let service: DisputesService;

  const manager = {} as EntityManager;
  const principal = makeSessionPrincipal({ merchant_id: TEST_MERCHANT_ID });
  const DISPUTE_ID = 'dp_01HQZZTESTDISPUTE000000001';
  const OPENED_AT = '2026-01-15T09:30:00.000Z';

  function chargeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_CHARGE_ID,
      merchantId: TEST_MERCHANT_ID,
      acquirer: 'worldflow',
      currency: 'GBP',
      status: 'settled',
      amount_minor: 12_000,
      captured_amount_minor: 12_000,
      refundableAmountMinor: 12_000,
      three_d_secure: null,
      livemode: true,
      ...overrides,
    };
  }

  function disputeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: DISPUTE_ID,
      merchantId: TEST_MERCHANT_ID,
      charge_id: TEST_CHARGE_ID,
      amount_minor: 12_000,
      fee_minor: 1_500,
      currency: 'GBP',
      status: 'needs_response',
      reason: 'fraudulent',
      network_reason_code: '10.4',
      evidence_due_by: new Date('2026-02-05T09:30:00.000Z'),
      evidence: {},
      is_charge_refundable: true,
      liability_shifted: false,
      submitted_at: null,
      resolved_at: null,
      livemode: true,
      createdAt: new Date(OPENED_AT),
      ...overrides,
    };
  }

  function openCommand(overrides: Record<string, unknown> = {}) {
    return {
      chargeId: TEST_CHARGE_ID,
      reason: 'fraudulent' as const,
      networkReasonCode: '10.4',
      amountMinor: 12_000,
      isWarning: false,
      occurredAt: OPENED_AT,
      correlationId: 'corr_dispute_1',
      ...overrides,
    };
  }

  beforeEach(() => {
    disputes = {
      insertDispute: jest.fn().mockImplementation((_m, row) => Promise.resolve(disputeRow({ ...row, id: row.id }))),
      findOpenForCharge: jest.fn().mockResolvedValue(null),
      saveEvidence: jest.fn().mockResolvedValue(1),
      transitionStatus: jest.fn().mockResolvedValue(1),
      findPastEvidenceDeadline: jest.fn().mockResolvedValue([]),
      findScoped: jest.fn().mockResolvedValue(disputeRow()),
      paginateCursor: jest.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false }),
    } as unknown as jest.Mocked<DisputeRepository>;

    charges = { findOne: jest.fn().mockResolvedValue(chargeRow()) } as unknown as jest.Mocked<ChargeRepository>;
    fees = { feeFor: jest.fn().mockResolvedValue(1_500) } as unknown as jest.Mocked<DisputeFeeService>;

    evidence = {
      assertSubmittable: jest.fn(),
      normalise: jest.fn().mockImplementation((existing, incoming) => ({ ...existing, ...incoming })),
      fieldCount: jest.fn().mockReturnValue(3),
    } as unknown as jest.Mocked<DisputeEvidenceService>;

    ledger = { recordDispute: jest.fn().mockResolvedValue({ id: 'txn_dispute_1' }) } as unknown as jest.Mocked<LedgerReadThroughService>;
    ids = { disputeId: jest.fn().mockReturnValue(DISPUTE_ID) } as unknown as jest.Mocked<IdFactory>;
    events = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EventPublisher>;

    transactions = {
      runInTransaction: jest.fn().mockImplementation((fn: (m: EntityManager) => Promise<unknown>) => fn(manager)),
    } as unknown as TransactionManager;

    clock = new FixedClock('2026-01-20T08:00:00.000Z');

    service = new DisputesService(
      disputes,
      charges,
      fees,
      evidence,
      new DisputeStateMachine(),
      ledger,
      transactions,
      ids,
      events,
      clock,
      new NoopLogger(),
    );
  });

  it('names its entity', () => {
    expect(service.entityName).toBe('dispute');
  });

  describe('openFromWebhook', () => {
    it('throws ChargeNotFoundException when the acquirer references a charge we never saw', async () => {
      charges.findOne.mockResolvedValue(null as never);

      await expect(service.openFromWebhook(openCommand())).rejects.toBeInstanceOf(ChargeNotFoundException);
    });

    it(`gives the merchant ${EVIDENCE_WINDOW_DAYS} days to respond`, async () => {
      await service.openFromWebhook(openCommand());

      const row = disputes.insertDispute.mock.calls[0][1] as { evidenceDueBy: Date };
      const days = (row.evidenceDueBy.getTime() - new Date(OPENED_AT).getTime()) / 86_400_000;
      expect(days).toBe(EVIDENCE_WINDOW_DAYS);
    });

    it('records the 3DS liability shift so the console can tell the merchant not to bother', async () => {
      charges.findOne.mockResolvedValue(
        chargeRow({ three_d_secure: { liability_shifted: true, authentication_flow: 'frictionless' } }) as never,
      );

      await service.openFromWebhook(openCommand());

      expect(disputes.insertDispute).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ liabilityShifted: true }),
      );
    });

    it('emits dispute.opened inside the same transaction as the insert', async () => {
      await service.openFromWebhook(openCommand());

      expect(events.publish).toHaveBeenCalledWith(
        'dispute.opened',
        expect.objectContaining({
          dispute_id: DISPUTE_ID,
          charge_id: TEST_CHARGE_ID,
          network_reason_code: '10.4',
          fee_minor: 1_500,
        }),
        expect.objectContaining({ correlationId: 'corr_dispute_1', livemode: true }),
      );
    });

    it('translates a 23505 on uq_dispute_charge_open into DuplicateDisputeException', async () => {
      // The acquirer redelivers its whole file after an outage. Insert-first means the unique
      // index — not a racy SELECT — is what tells us we already have this one.
      (transactions.runInTransaction as jest.Mock).mockRejectedValue(
        new ConflictException('dispute already open for charge'),
      );

      await expect(service.openFromWebhook(openCommand())).rejects.toBeInstanceOf(DuplicateDisputeException);
    });

    it('lets a non-conflict failure through untouched', async () => {
      (transactions.runInTransaction as jest.Mock).mockRejectedValue(new Error('connection terminated'));

      await expect(service.openFromWebhook(openCommand())).rejects.toThrow('connection terminated');
    });

    function dto(overrides: Partial<SubmitDisputeEvidenceDto> = {}): SubmitDisputeEvidenceDto {
      return Object.assign(new SubmitDisputeEvidenceDto(), {
        evidence: Object.assign(new DisputeEvidenceDto(), {
          customer_name: 'Loomcraft Interiors Ltd',
          shipping_tracking_number: 'DHL-771-0044',
          receipt_file_id: 'file_01HQZZRECEIPT',
        }),
        submit: true,
        ...overrides,
      });
    }

    it('asks the evidence service whether the dispute can still take evidence', async () => {
      await service.submitEvidence(principal, DISPUTE_ID, dto(), 'corr_2');

      expect(evidence.assertSubmittable).toHaveBeenCalled();
    });

    it('moves the dispute to under_review and emits dispute.evidence_submitted', async () => {
      const result = await service.submitEvidence(principal, DISPUTE_ID, dto(), 'corr_2');

      expect(disputes.saveEvidence).toHaveBeenCalledWith(manager, DISPUTE_ID, expect.any(Object), clock.now());
      expect(events.publish).toHaveBeenCalledWith(
        'dispute.evidence_submitted',
        expect.objectContaining({ dispute_id: DISPUTE_ID, evidence_field_count: 3 }),
        expect.anything(),
      );
      expect(result.status).toBe('under_review');
    });

    it('saves a draft without submitting or emitting', async () => {
      const result = await service.submitEvidence(principal, DISPUTE_ID, dto({ submit: false }), 'corr_2');

      expect(disputes.saveEvidence).toHaveBeenCalledWith(manager, DISPUTE_ID, expect.any(Object), null);
      expect(events.publish).not.toHaveBeenCalled();
      expect(result.status).toBe('needs_response');
    });

    it('refuses to submit evidence on a dispute the network already closed', async () => {
      disputes.findScoped.mockResolvedValue(disputeRow({ status: 'lost' }) as never);

      await expect(
        service.submitEvidence(principal, DISPUTE_ID, dto(), 'corr_2'),
      ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    });

    it('throws a 404 when the deadline job closed it between our read and our write', async () => {
      disputes.saveEvidence.mockResolvedValue(0 as never);

      await expect(
        service.submitEvidence(principal, DISPUTE_ID, dto(), 'corr_2'),
      ).rejects.toBeInstanceOf(DisputeNotFoundException);
    });
  });

  describe('accept', () => {
    it('closes the dispute as lost and emits dispute.closed exactly once', async () => {
      const result = await service.accept(principal, DISPUTE_ID, 'corr_3');

      expect(disputes.transitionStatus).toHaveBeenCalledWith(
        manager,
        DISPUTE_ID,
        'needs_response',
        'lost',
        clock.now(),
      );
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith(
        'dispute.closed',
        expect.objectContaining({ outcome: 'lost', dispute_id: DISPUTE_ID, reversal_transaction_id: null }),
        expect.anything(),
      );
      expect(result).toMatchObject({ status: 'lost', resolved_at: clock.nowIso() });
    });

    it('throws a 404 when the compare-and-swap on status finds nothing', async () => {
      disputes.transitionStatus.mockResolvedValue(0 as never);

      await expect(service.accept(principal, DISPUTE_ID, 'corr_3')).rejects.toBeInstanceOf(
        DisputeNotFoundException,
      );
    });
  });

  describe('closeFromWebhook', () => {
    it('returns null when the acquirer replays a verdict for a dispute we already closed', async () => {
      disputes.findOpenForCharge.mockResolvedValue(null as never);

      await expect(service.closeFromWebhook(TEST_CHARGE_ID, 'won', 'corr_4')).resolves.toBeNull();
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('rejects a `won` verdict for a dispute the merchant never responded to', async () => {
      // It happens, and we want it in the logs rather than silently reversing a liability leg.
      disputes.findOpenForCharge.mockResolvedValue(disputeRow({ status: 'needs_response' }) as never);

      await expect(service.closeFromWebhook(TEST_CHARGE_ID, 'won', 'corr_4')).rejects.toBeInstanceOf(
        InvalidStateTransitionException,
      );
    });
  });

  describe('reads', () => {
    it('scopes get to the principal’s merchant and throws DisputeNotFoundException otherwise', async () => {
      disputes.findScoped.mockResolvedValue(null as never);

      await expect(service.get(principal, 'dp_foreign')).rejects.toBeInstanceOf(DisputeNotFoundException);
      expect(disputes.findScoped).toHaveBeenCalledWith(
        'dp_foreign',
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID }),
      );
    });

  });
});
