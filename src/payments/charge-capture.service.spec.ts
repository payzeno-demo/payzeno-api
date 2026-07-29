import { Test } from '@nestjs/testing';

import { ChargeNotCapturableException } from 'src/common/errors/state.exceptions';
import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { OutboxEventPublisher } from 'src/events/outbox-event.publisher';
import { ChargeCaptureService } from 'src/payments/charge-capture.service';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ProcessorRouter } from 'src/payments/processor/processor.router';

import { makeCapturedCharge, makeCharge } from 'test/factories/charge.factory';
import { makeMerchant, makeDeferredCaptureMerchant } from 'test/factories/merchant.factory';

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
        { provide: PayzenoLogger, useValue: new NoopLogger() },
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
