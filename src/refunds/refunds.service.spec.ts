import type { EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ProcessorRouter } from 'src/payments/processor/processor.router';
import type { ProcessorAdapter } from 'src/payments/processor/processor.adapter';
import { IdFactory } from 'src/common/ids/id.factory';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import type { EventPublisher } from 'src/events/publisher';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';
import { RefundsService } from 'src/refunds/refunds.service';
import { RefundRepository } from 'src/refunds/refund.repository';
import { RefundPolicyService } from 'src/refunds/refund-policy.service';
import { RefundStateMachine } from 'src/refunds/state/refund.state-machine';
import { CreateRefundDto } from 'src/refunds/dto/create-refund.dto';

import { FixedClock } from 'test/support/fixed-clock';
import { makeApiKeyPrincipal } from 'test/factories/principal.factory';
import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * `RefundsService`'s whole design is an ordering claim: write the row and the outbox event
 * inside one transaction, COMMIT, and only then call the acquirer. So most of what is worth
 * asserting here is *ordering* and *what happens on the unhappy branch*, not shapes.
 *
 * The acquirer is the part that fails. It failed for 22 minutes on the night of PAY-2041 and
 * these are the branches that ran.
 */
describe('RefundsService', () => {
  let refunds: jest.Mocked<RefundRepository>;
  let charges: jest.Mocked<ChargeRepository>;
  let policy: jest.Mocked<RefundPolicyService>;
  let router: jest.Mocked<ProcessorRouter>;
  let ledger: jest.Mocked<LedgerReadThroughService>;
  let transactions: TransactionManager;
  let ids: jest.Mocked<IdFactory>;
  let events: jest.Mocked<EventPublisher>;
  let adapter: jest.Mocked<ProcessorAdapter>;
  let clock: FixedClock;
  let service: RefundsService;

  /** Every write in this service joins the caller's manager; the specs never touch a real one. */
  const manager = {} as EntityManager;
  const principal = makeApiKeyPrincipal({ merchant_id: TEST_MERCHANT_ID });
  const REFUND_ID = 're_01HQZZTESTREFUND0000000001';

  function chargeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_CHARGE_ID,
      merchantId: TEST_MERCHANT_ID,
      status: 'captured',
      currency: 'GBP',
      acquirer: 'worldflow',
      amount_minor: 4_500,
      captured_amount_minor: 4_500,
      network_transaction_id: 'WF-8831-004471',
      livemode: true,
      ...overrides,
    };
  }

  function refundRow(overrides: Record<string, unknown> = {}) {
    return {
      id: REFUND_ID,
      merchantId: TEST_MERCHANT_ID,
      charge_id: TEST_CHARGE_ID,
      amount_minor: 1_500,
      currency: 'GBP',
      status: 'pending',
      reason: 'requested_by_customer',
      failure_reason: null,
      processor_reference: null,
      metadata: {},
      livemode: true,
      succeeded_at: null,
      createdAt: new Date('2026-01-15T12:00:00.000Z'),
      ...overrides,
    };
  }

  function dto(overrides: Partial<CreateRefundDto> = {}): CreateRefundDto {
    return Object.assign(new CreateRefundDto(), {
      charge_id: TEST_CHARGE_ID,
      amount_minor: 1_500,
      reason: undefined,
      metadata: undefined,
      ...overrides,
    });
  }

  beforeEach(() => {
    refunds = {
      insertRefund: jest.fn().mockImplementation((_m, row) => Promise.resolve(refundRow({ id: row.id }))),
      markSucceeded: jest.fn().mockResolvedValue(1),
      markFailed: jest.fn().mockResolvedValue(1),
      findByProcessorReference: jest.fn().mockResolvedValue(null),
      findAllForCharge: jest.fn().mockResolvedValue([]),
      findScoped: jest.fn(),
      paginateCursor: jest.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false }),
    } as unknown as jest.Mocked<RefundRepository>;

    charges = {
      addRefundedAmount: jest.fn().mockResolvedValue(undefined),
      findScoped: jest.fn().mockResolvedValue(chargeRow()),
    } as unknown as jest.Mocked<ChargeRepository>;

    policy = {
      evaluate: jest.fn().mockResolvedValue({
        charge: chargeRow(),
        amountMinor: 1_500,
        reason: 'requested_by_customer',
        netsAgainstSettlement: true,
      }),
    } as unknown as jest.Mocked<RefundPolicyService>;

    adapter = {
      acquirer: 'worldflow',
      refund: jest.fn().mockResolvedValue({
        refunded: true,
        processorReference: 'WF-RF-77120',
        failureReason: null,
      }),
    } as unknown as jest.Mocked<ProcessorAdapter>;

    router = { forAcquirer: jest.fn().mockReturnValue(adapter) } as unknown as jest.Mocked<ProcessorRouter>;
    ledger = { recordRefund: jest.fn().mockResolvedValue({ id: 'txn_1' }) } as unknown as jest.Mocked<LedgerReadThroughService>;
    ids = { refundId: jest.fn().mockReturnValue(REFUND_ID) } as unknown as jest.Mocked<IdFactory>;
    events = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EventPublisher>;

    transactions = {
      runInTransaction: jest.fn().mockImplementation((fn: (m: EntityManager) => Promise<unknown>) => fn(manager)),
    } as unknown as TransactionManager;

    clock = new FixedClock('2026-01-15T12:00:00.000Z');

    service = new RefundsService(
      refunds,
      charges,
      policy,
      new RefundStateMachine(),
      router,
      ledger,
      transactions,
      ids,
      events,
      clock,
      new NoopLogger(),
    );
  });

  it('names its entity', () => {
    expect(service.entityName).toBe('refund');
  });

  describe('create', () => {
    it('evaluates the policy inside the transaction, before anything is written', async () => {
      await service.create(principal, dto(), 'corr_1');

      expect(policy.evaluate).toHaveBeenCalledWith(manager, TEST_CHARGE_ID, 1_500, undefined);
      expect(transactions.runInTransaction).toHaveBeenCalled();
    });

    it('writes the row with the amount the policy decided, not the amount asked for', async () => {
      policy.evaluate.mockResolvedValue({
        charge: chargeRow(),
        amountMinor: 3_000,
        reason: 'duplicate',
        netsAgainstSettlement: true,
      } as never);

      await service.create(principal, dto({ amount_minor: undefined }), 'corr_1');

      expect(refunds.insertRefund).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ amountMinor: 3_000, reason: 'duplicate', chargeId: TEST_CHARGE_ID }),
      );
    });

    it('reserves the amount on the charge so the next policy read sees it', async () => {
      await service.create(principal, dto(), 'corr_1');

      expect(charges.addRefundedAmount).toHaveBeenCalledWith(manager, TEST_CHARGE_ID, 1_500);
    });

    it('enqueues refund.created on the outbox in the same transaction', async () => {
      await service.create(principal, dto(), 'corr_1');

      expect(events.publish).toHaveBeenCalledWith(
        'refund.created',
        expect.objectContaining({
          refund_id: REFUND_ID,
          charge_id: TEST_CHARGE_ID,
          amount_minor: 1_500,
          nets_against_settlement: true,
        }),
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID, correlationId: 'corr_1', livemode: true }),
      );
    });

    it('calls the acquirer only after the transaction has returned', async () => {
      const order: string[] = [];
      (transactions.runInTransaction as jest.Mock).mockImplementation(
        async (fn: (m: EntityManager) => Promise<unknown>) => {
          const result = await fn(manager);
          order.push('commit');
          return result;
        },
      );
      adapter.refund.mockImplementation(async () => {
        order.push('acquirer');
        return { refunded: true, processorReference: 'WF-RF-77120', failureReason: null };
      });

      await service.create(principal, dto(), 'corr_1');

      expect(order[0]).toBe('commit');
      expect(order).toContain('acquirer');
    });

    it('routes to the charge’s own acquirer, not the merchant’s current default', async () => {
      charges.findScoped.mockResolvedValue(chargeRow({ acquirer: 'nordpay' }) as never);

      await service.create(principal, dto(), 'corr_1');

      expect(router.forAcquirer).toHaveBeenCalledWith('nordpay', { livemode: true });
    });

    it('sends a deterministic idempotency key so a replay is free at the acquirer', async () => {
      await service.create(principal, dto(), 'corr_1');

      expect(adapter.refund).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `refund:${TEST_CHARGE_ID}:${REFUND_ID}`,
          networkTransactionId: 'WF-8831-004471',
          amountMinor: 1_500,
        }),
      );
    });

    it('marks the refund succeeded and posts it to the ledger', async () => {
      const refund = await service.create(principal, dto(), 'corr_1');

      expect(refunds.markSucceeded).toHaveBeenCalledWith(manager, REFUND_ID, 'WF-RF-77120', clock.now());
      expect(ledger.recordRefund).toHaveBeenCalledWith(
        expect.objectContaining({ refundId: REFUND_ID, chargeId: TEST_CHARGE_ID, amountMinor: 1_500 }),
      );
      expect(refund).toMatchObject({ status: 'succeeded', processor_reference: 'WF-RF-77120' });
    });

    it('throws when the charge vanished from the principal’s scope between commit and submit', async () => {
      charges.findScoped.mockResolvedValue(null as never);

      await expect(service.create(principal, dto(), 'corr_1')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    describe('when the acquirer says no', () => {
      it('releases the reservation and emits refund.failed', async () => {
        adapter.refund.mockResolvedValue({
          refunded: false,
          processorReference: '',
          failureReason: 'issuer_unavailable',
        } as never);

        const refund = await service.create(principal, dto(), 'corr_1');

        expect(refunds.markFailed).toHaveBeenCalledWith(manager, REFUND_ID, 'issuer_unavailable');
        expect(charges.addRefundedAmount).toHaveBeenLastCalledWith(manager, TEST_CHARGE_ID, -1_500);
        expect(events.publish).toHaveBeenCalledWith(
          'refund.failed',
          expect.objectContaining({ failure_reason: 'issuer_unavailable' }),
          expect.anything(),
        );
        expect(refund).toMatchObject({ status: 'failed', failure_reason: 'issuer_unavailable' });
      });

      it('never posts a failed refund to the ledger', async () => {
        adapter.refund.mockResolvedValue({ refunded: false, processorReference: '', failureReason: null } as never);

        await service.create(principal, dto(), 'corr_1');

        expect(ledger.recordRefund).not.toHaveBeenCalled();
      });

      it('turns a thrown acquirer error into a failed refund rather than a 500', async () => {
        adapter.refund.mockRejectedValue(new Error('read_timeout: worldflow'));

        const refund = await service.create(principal, dto(), 'corr_1');

        // TODO(PAY-2011) is exactly this: the acquirer's exception CLASS is lost here and only
        // its message survives. The spec pins the current behaviour so the fix has a baseline.
        expect(refund).toMatchObject({ status: 'failed', failure_reason: 'read_timeout: worldflow' });
      });
    });
  });

  describe('markSettledFromWebhook', () => {
    it('returns null for a reference we do not know', async () => {
      await expect(service.markSettledFromWebhook('WF-RF-unknown', { failed: false, failureReason: '' }))
        .resolves.toBeNull();
    });

    it('is a no-op for a refund that already succeeded', async () => {
      refunds.findByProcessorReference.mockResolvedValue(refundRow({ status: 'succeeded' }) as never);

      const row = await service.markSettledFromWebhook('WF-RF-77120', { failed: false, failureReason: '' });

      expect(row).toMatchObject({ status: 'succeeded' });
      expect(refunds.markSucceeded).not.toHaveBeenCalled();
    });

    it('settles a pending refund', async () => {
      refunds.findByProcessorReference.mockResolvedValue(refundRow() as never);

      const row = await service.markSettledFromWebhook('WF-RF-77120', { failed: false, failureReason: '' });

      expect(refunds.markSucceeded).toHaveBeenCalledWith(manager, REFUND_ID, 'WF-RF-77120', clock.now());
      expect(row).toMatchObject({ status: 'succeeded' });
    });

    it('reverses the reservation when the file says the reversal failed two days later', async () => {
      refunds.findByProcessorReference.mockResolvedValue(refundRow() as never);

      const row = await service.markSettledFromWebhook('WF-RF-77120', {
        failed: true,
        failureReason: 'reversal_rejected',
      });

      expect(refunds.markFailed).toHaveBeenCalledWith(manager, REFUND_ID, 'reversal_rejected');
      expect(charges.addRefundedAmount).toHaveBeenCalledWith(manager, TEST_CHARGE_ID, -1_500);
      expect(row).toMatchObject({ status: 'failed', failure_reason: 'reversal_rejected' });
    });
  });

  describe('reads', () => {
    it('scopes get to the principal’s merchant', async () => {
      refunds.findScoped.mockResolvedValue(refundRow() as never);

      await expect(service.get(principal, REFUND_ID)).resolves.toMatchObject({ id: REFUND_ID });
      expect(refunds.findScoped).toHaveBeenCalledWith(
        REFUND_ID,
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID, livemode: true }),
      );
    });

    it('throws a 404 rather than leaking another tenant’s refund', async () => {
      refunds.findScoped.mockResolvedValue(null as never);

      await expect(service.get(principal, 're_foreign')).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('narrows the list by charge_id when asked', async () => {
      await service.list(principal, { limit: 25, charge_id: TEST_CHARGE_ID });

      expect(refunds.paginateCursor).toHaveBeenCalled();
    });

    it('filters listForCharge down to the principal’s merchant in memory', async () => {
      refunds.findAllForCharge.mockResolvedValue([
        refundRow(),
        refundRow({ id: 're_other', merchantId: 'mch_someone_else' }),
      ] as never);

      const rows = await service.listForCharge(principal, TEST_CHARGE_ID);

      // TODO(PAY-1988) tracks pushing this predicate into SQL. Until then, this assertion is
      // the only thing stopping a cross-tenant read on the charge detail panel.
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(REFUND_ID);
    });
  });
});
