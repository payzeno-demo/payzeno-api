import { Test } from '@nestjs/testing';

import { ChargeNotCapturableException } from 'src/common/errors/state.exceptions';
import { NoopLogger, PAYZENO_LOGGER } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { OutboxEventPublisher } from 'src/events/outbox-event.publisher';
import { ChargeCaptureService } from 'src/payments/charge-capture.service';
import { ChargeRepository } from 'src/payments/charge.repository';
import type { ReceiptEmailsService } from 'src/payments/receipt-emails.service';
import { ProcessorRouter } from 'src/payments/processor/processor.router';

import { ChargeEntity } from 'src/payments/charge.entity';
import { ChargeStateMachine } from 'src/payments/state/charge.state-machine';
import type { EventPublisher } from 'src/events/publisher';
import type { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';

import { makeCapturedCharge, makeCharge } from 'test/factories/charge.factory';
import { makeMerchant, makeDeferredCaptureMerchant } from 'test/factories/merchant.factory';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * Frame 4 of the deepest chain in the repo, and the file arcs PCI, INC and MIG have all
 * touched.
 *
 * The rule this spec exists to protect: when `merchant.capture_at_settlement` is true,
 * payzeno-api does NOT call the acquirer. The ledger issues the capture at settlement.
 * A capture from both sides is the double-charge of arc INC.
 */
describe('ChargeCaptureService', () => {
  let service: ChargeCaptureService;
  let repo: jest.Mocked<ChargeRepository>;
  let router: jest.Mocked<ProcessorRouter>;
  let publisher: jest.Mocked<OutboxEventPublisher>;
  let txm: jest.Mocked<TransactionManager>;
  let adapter: { acquirer: 'worldflow'; capture: jest.Mock };

  beforeEach(async () => {
    adapter = {
      acquirer: 'worldflow',
      capture: jest.fn().mockResolvedValue({
        captured: true,
        processorReference: 'wf_cap_1',
        capturedAmountMinor: 4_500,
        capturedAt: '2026-01-15T12:00:00.000Z',
      }),
    };

    repo = {
      lockForUpdate: jest.fn(),
      markCaptured: jest.fn().mockImplementation(async (id: string) => makeCapturedCharge({ id })),
    } as unknown as jest.Mocked<ChargeRepository>;

    router = { select: jest.fn().mockReturnValue(adapter) } as unknown as jest.Mocked<ProcessorRouter>;
    publisher = { publish: jest.fn().mockResolvedValue('evt_1') } as unknown as jest.Mocked<OutboxEventPublisher>;
    txm = {
      runInTransaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})),
    } as unknown as jest.Mocked<TransactionManager>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChargeCaptureService,
        { provide: ChargeRepository, useValue: repo },
        { provide: ProcessorRouter, useValue: router },
        { provide: OutboxEventPublisher, useValue: publisher },
        { provide: TransactionManager, useValue: txm },
        { provide: PAYZENO_LOGGER, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(ChargeCaptureService);
  });

  const merchant = makeMerchant();

  it('captures an authorised charge through the acquirer', async () => {
    const charge = makeCharge({ status: 'authorized' });
    repo.lockForUpdate.mockResolvedValue(charge as never);

    const result = await service.captureCharge(merchant, charge.id, 4_500);

    expect(adapter.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        networkTransactionId: charge.network_transaction_id,
        amountMinor: 4_500,
      }),
    );
    expect(result.status).toBe('captured');
  });

  it('locks the row FOR UPDATE before deciding anything', async () => {
    const charge = makeCharge({ status: 'authorized' });
    repo.lockForUpdate.mockResolvedValue(charge as never);

    await service.captureCharge(merchant, charge.id, 4_500);

    expect(repo.lockForUpdate).toHaveBeenCalledWith(charge.id, expect.anything());
    expect(repo.lockForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.capture.mock.invocationCallOrder[0],
    );
  });

  it('runs the capture inside a transaction', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

    await service.captureCharge(merchant, 'ch_1', 4_500);

    expect(txm.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it('emits payment.captured through the outbox, inside the same transaction', async () => {
    const charge = makeCharge({ status: 'authorized' });
    repo.lockForUpdate.mockResolvedValue(charge as never);

    await service.captureCharge(merchant, charge.id, 4_500);

    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.captured',
      expect.objectContaining({
        charge_id: charge.id,
        captured_amount_minor: 4_500,
        authorized_amount_minor: charge.amount_minor,
      }),
      expect.anything(),
    );
  });

  it('throws ChargeNotCapturableException for a charge that is not authorized', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCapturedCharge() as never);

    await expect(service.captureCharge(merchant, 'ch_1', 4_500)).rejects.toBeInstanceOf(
      ChargeNotCapturableException,
    );
    expect(adapter.capture).not.toHaveBeenCalled();
  });

  it('throws ChargeNotCapturableException for an expired authorisation', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'expired' }) as never);

    await expect(service.captureCharge(merchant, 'ch_1', 4_500)).rejects.toBeInstanceOf(
      ChargeNotCapturableException,
    );
  });

  it('refuses to capture more than was authorised', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized', amount_minor: 4_500 }) as never);

    await expect(service.captureCharge(merchant, 'ch_1', 9_000)).rejects.toThrow();
    expect(adapter.capture).not.toHaveBeenCalled();
  });

  it('allows a partial capture', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized', amount_minor: 4_500 }) as never);

    await service.captureCharge(merchant, 'ch_1', 2_000);

    expect(adapter.capture).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 2_000 }));
  });

  describe('capture_at_settlement (arc INC)', () => {
    it('does NOT call the acquirer when the ledger owns the capture', async () => {
      repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

      await service.captureCharge(makeDeferredCaptureMerchant(), 'ch_1', 4_500);

      // The whole point. Two captures for one authorisation is PAY-2041.
      expect(adapter.capture).not.toHaveBeenCalled();
    });

    it('still emits payment.captured so the ledger knows to schedule it', async () => {
      repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

      await service.captureCharge(makeDeferredCaptureMerchant(), 'ch_1', 4_500);

      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.captured',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it('uses a deterministic idempotency key derived from the charge, not a counter', async () => {
    const charge = makeCharge({ status: 'authorized' });
    repo.lockForUpdate.mockResolvedValue(charge as never);

    await service.captureCharge(merchant, charge.id, 4_500);
    const firstKey = adapter.capture.mock.calls[0][0].idempotencyKey;

    adapter.capture.mockClear();
    repo.lockForUpdate.mockResolvedValue(charge as never);
    await service.captureCharge(merchant, charge.id, 4_500);
    const secondKey = adapter.capture.mock.calls[0][0].idempotencyKey;

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toContain(charge.id);
  });
});

/**
 * Built directly rather than through the testing module above, against the service's current
 * constructor. Kept separate so it runs whatever state the suite above is in.
 */
describe('ChargeCaptureService — event ordering', () => {
  it('dates payment.captured when Payzeno recorded it, not when the acquirer says it captured', async () => {
    // Regression: a sale (authorise + capture in one acquirer call) is dated by the acquirer at
    // the authorisation instant — before our own `authorized_at`. With that as the envelope's
    // occurred_at the ledger's projection guard dropped every automatic capture as stale.
    const clock = new FixedClock('2026-01-15T12:00:05.000Z');
    const adapter = {
      capture: jest.fn().mockResolvedValue({
        captured: true,
        processorReference: 'wf_cap_1',
        capturedAmountMinor: 4_500,
        capturedAt: '2026-01-15T12:00:00.000Z',
      }),
    };
    const events: jest.Mocked<EventPublisher> = {
      publish: jest.fn().mockResolvedValue('evt_1'),
      publishBatch: jest.fn().mockResolvedValue([]),
    };
    const service = new ChargeCaptureService(
      { markCaptured: jest.fn().mockResolvedValue(1) } as unknown as ChargeRepository,
      { forAcquirer: jest.fn().mockReturnValue(adapter) } as unknown as ProcessorRouter,
      new ChargeStateMachine(),
      { runInTransaction: jest.fn(async (work: (manager: unknown) => unknown) => work({})) } as unknown as TransactionManager,
      { recordCapture: jest.fn().mockResolvedValue(undefined) } as unknown as LedgerReadThroughService,
      // RFC platform-v2: no intent behind this charge, so no receipt and no subscription tag.
      { intentOf: jest.fn().mockResolvedValue(null), queueReceipt: jest.fn() } as Partial<ReceiptEmailsService> as ReceiptEmailsService,
      events,
      clock,
      new NoopLogger(),
    );
    const charge = Object.assign(new ChargeEntity(), {
      id: 'ch_1',
      payment_intent_id: 'pi_1',
      status: 'authorized' as const,
      amount_minor: 4_500,
      currency: 'USD',
      livemode: true,
      acquirer: 'worldflow' as const,
      network_transaction_id: 'ntid_1',
      processor_reference: 'wf_auth_1',
      authorization_expires_at: null,
    });

    await service.captureCharge({ charge, merchant: makeMerchant(), correlationId: 'corr_1' });

    expect(events.publish).toHaveBeenCalledWith(
      'payment.captured',
      expect.objectContaining({ captured_at: '2026-01-15T12:00:00.000Z' }),
      expect.objectContaining({ occurredAt: '2026-01-15T12:00:05.000Z' }),
    );
  });
});
