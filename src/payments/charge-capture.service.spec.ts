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

  const merchant = makeMerchant();

  it('runs the capture inside a transaction', async () => {
    repo.lockForUpdate.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

    await service.captureCharge(merchant, 'ch_1', 4_500);

    expect(txm.runInTransaction).toHaveBeenCalledTimes(1);
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
