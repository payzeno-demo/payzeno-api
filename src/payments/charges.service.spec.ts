import { Test } from '@nestjs/testing';

import { ChargeNotFoundException } from 'src/common/errors/not-found.exceptions';
import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ChargesService } from 'src/payments/charges.service';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';

import { makeApiKeyPrincipal, makeSessionPrincipal } from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { makeCapturedCharge, makeCharge, makeSettledCharge } from 'test/factories/charge.factory';

/**
 * `ChargesService` is read-heavy — the write path lives in
 * `ChargeAuthorizationService` / `ChargeCaptureService`. Its one interesting write is
 * `markSettled`, which the internal surface and PAY-2042's 218 remediation refunds both
 * went through.
 */
describe('ChargesService', () => {
  let service: ChargesService;
  let repo: jest.Mocked<ChargeRepository>;
  let ledger: jest.Mocked<LedgerReadThroughService>;

  const principal = makeApiKeyPrincipal({ merchant_id: TEST_MERCHANT_ID });

  beforeEach(async () => {
    repo = {
      findScoped: jest.fn(),
      paginateCursor: jest.fn(),
      markSettled: jest.fn(),
      findByProcessorReference: jest.fn(),
    } as unknown as jest.Mocked<ChargeRepository>;

    ledger = {
      listChargeTransactions: jest.fn(),
    } as unknown as jest.Mocked<LedgerReadThroughService>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChargesService,
        { provide: ChargeRepository, useValue: repo },
        { provide: LedgerReadThroughService, useValue: ledger },
        { provide: PayzenoLogger, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(ChargesService);
  });

  it('names its entity', () => {
    expect(service.entityName).toBe('charge');
  });

  describe('get', () => {
    it('returns a charge in the principal’s scope', async () => {
      const charge = makeCharge();
      repo.findScoped.mockResolvedValue(charge as never);

      await expect(service.get(principal, charge.id)).resolves.toMatchObject({ id: charge.id });
      expect(repo.findScoped).toHaveBeenCalledWith(
        charge.id,
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID }),
      );
    });

    it('throws ChargeNotFoundException for a charge in another tenant', async () => {
      repo.findScoped.mockResolvedValue(null as never);

      await expect(service.get(principal, 'ch_foreign')).rejects.toBeInstanceOf(
        ChargeNotFoundException,
      );
    });
  });

  describe('list', () => {
    it('reads the charge first, then its transactions', async () => {
      const charge = makeSettledCharge();
      repo.findScoped.mockResolvedValue(charge as never);
      ledger.listChargeTransactions.mockResolvedValue([] as never);

      const result = await service.getLedger(makeSessionPrincipal(), charge.id);

      const scopeOrder = repo.findScoped.mock.invocationCallOrder[0];
      const ledgerOrder = ledger.listChargeTransactions.mock.invocationCallOrder[0];
      expect(scopeOrder).toBeLessThan(ledgerOrder);
      expect(result.charge_id).toBe(charge.id);
    });

    it('moves a captured charge to settled and stamps the batch', async () => {
      const charge = makeCapturedCharge();
      repo.findScoped.mockResolvedValue(charge as never);
      repo.markSettled.mockResolvedValue(
        makeSettledCharge({ id: charge.id, settlement_batch_id: 'sb_20260113_wf' }) as never,
      );

      const result = await service.markSettled(charge.id, {
        settlement_batch_id: 'sb_20260113_wf',
        settled_at: '2026-01-13T04:20:00.000Z',
        transaction_id: 'ltx_000777',
      });

      expect(result.status).toBe('settled');
      expect(repo.markSettled).toHaveBeenCalledWith(
        charge.id,
        expect.objectContaining({ settlement_batch_id: 'sb_20260113_wf' }),
      );
    });

    it('is a no-op when the charge is already settled into the same batch', async () => {
      const charge = makeSettledCharge({ settlement_batch_id: 'sb_20260113_wf' });
      repo.findScoped.mockResolvedValue(charge as never);

      const result = await service.markSettled(charge.id, {
        settlement_batch_id: 'sb_20260113_wf',
        settled_at: '2026-01-13T04:20:00.000Z',
        transaction_id: 'ltx_000777',
      });

      // Redelivery of `settlement.completed` and the internal route both land here.
      expect(repo.markSettled).not.toHaveBeenCalled();
      expect(result.status).toBe('settled');
    });

    it('refuses to settle a charge that was never captured', async () => {
      repo.findScoped.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

      await expect(
        service.markSettled('ch_auth', {
          settlement_batch_id: 'sb_1',
          settled_at: '2026-01-13T04:20:00.000Z',
          transaction_id: 'ltx_1',
        }),
      ).rejects.toThrow();
    });
  });

  describe('findByProcessorReference', () => {
    it('resolves an inbound acquirer webhook back to a charge', async () => {
      const charge = makeCharge();
      repo.findByProcessorReference.mockResolvedValue(charge as never);

      const result = await service.findByProcessorReference('worldflow', 'wf_auth_0001');

      expect(result?.id).toBe(charge.id);
      expect(repo.findByProcessorReference).toHaveBeenCalledWith('worldflow', 'wf_auth_0001');
    });

  });
});
