import type { EntityManager } from 'typeorm';

import { ValidationException } from 'src/common/errors/api.exception';
import { LedgerUnavailableException } from 'src/common/errors/upstream.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { EventPublisher } from 'src/events/publisher';
import type { LedgerHttpClient } from 'src/ledger/ledger-http.client';
import { MerchantOnboardingService } from 'src/merchants/merchant-onboarding.service';
import type { MerchantRepository } from 'src/merchants/merchant.repository';

import { makeCreateMerchantRequest } from 'test/factories/merchant.factory';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * Chain E of the blueprint, and the only cross-repo WRITE payzeno-api performs inside a
 * request. The ledger bootstrap is deliberately INSIDE the transaction (PAY-1284): the
 * alternative leaves a merchant that exists here with no chart of accounts there, and the
 * first authorisation for that merchant then fails in the money path.
 *
 * `AccountResolver.get_or_create` is idempotent ledger-side, so the staff operator's retry
 * with the same Idempotency-Key is free. An orphaned merchant is not.
 */
describe('MerchantOnboardingService', () => {
  const clock = new FixedClock('2026-02-01T10:00:00.000Z');

  let ledger: { bootstrapAccounts: jest.Mock };
  let transactions: TransactionManager;
  let service: MerchantOnboardingService;

  beforeEach(() => {
    merchants = {
      insertMapped: jest.fn().mockResolvedValue(undefined),
      findByLegalName: jest.fn().mockResolvedValue(null),
    };
    ledger = { bootstrapAccounts: jest.fn().mockResolvedValue({ accounts: [], created: 9 }) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    transactions = {
      runInTransaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) =>
        cb({} as EntityManager),
      ),
    } as unknown as TransactionManager;

    service = new MerchantOnboardingService(
      merchants as unknown as MerchantRepository,
      transactions,
      ledger as unknown as LedgerHttpClient,
      new IdFactory(),
      events as unknown as EventPublisher,
      clock,
      new NoopLogger(),
    );
  });

  it('normalises the inputs the console lets a human type', async () => {
    const merchant = await service.onboard(request, true, 'stf_operator');

    expect(merchant.legalName).toBe('Aurora Coffee Roasters Ltd');
    expect(merchant.displayName).toBe('Aurora Coffee');
    expect(merchant.country).toBe('GB');
  });

  it('starts every merchant in pending_review with the standard risk tier', async () => {
    const merchant = await service.onboard(request, true, 'stf_operator');

    expect(merchant.status).toBe('pending_review');
    expect(merchant.riskTier).toBe('standard');
    expect(merchant.captureAtSettlement).toBe(false);
  });

  it('applies the data-model column defaults for a merchant nobody has priced', async () => {
    const merchant = await service.onboard(request, true, 'stf_operator');

    expect(merchant.platformFeeBps).toBe(290);
    expect(merchant.platformFeeFixedMinor).toBe(30);
    expect(merchant.payoutDelayDays).toBe(2);
    expect(merchant.settlementToleranceMinor).toBe(100);
    expect(merchant.reserveBps).toBe(0);
  });

  it('mints a prefixed merchant id', async () => {
    const merchant = await service.onboard(request, true, 'stf_operator');

    expect(merchant.id).toMatch(/^mch_/);
  });

  it('bootstraps the ledger chart for the merchant’s default currency', async () => {
    const merchant = await service.onboard(request, true, 'stf_operator');

    expect(ledger.bootstrapAccounts).toHaveBeenCalledWith(merchant.id, 'GBP', true);
  });

  describe('duplicate detection', () => {
    it('rejects a legal name already onboarded in the same country', async () => {
      merchants.findByLegalName.mockResolvedValue({ id: 'mch_existing' });

      await expect(service.onboard(request, true, 'stf_operator')).rejects.toBeInstanceOf(
        ValidationException,
      );
      expect(merchants.insertMapped).not.toHaveBeenCalled();
    });

    it('points the field error at legal_name so the console highlights the right input', async () => {
      merchants.findByLegalName.mockResolvedValue({ id: 'mch_existing' });

      try {
        await service.onboard(request, true, 'stf_operator');
        throw new Error('expected a ValidationException');
      } catch (err) {
        const fieldErrors = (err as ValidationException).fieldErrors;
        expect(fieldErrors[0]).toMatchObject({ path: 'legal_name', code: 'duplicate' });
        expect(fieldErrors[0].message).toContain('mch_existing');
      }
    });

    it('checks before it inserts, not after the 23505', async () => {
      await service.onboard(request, true, 'stf_operator');

      // Note the raw values: the duplicate check runs against the request as received,
      // before `build()` trims and upper-cases. `findByLegalName` is lower()-compared and
      // the trailing whitespace has never mattered in practice — but a console that stops
      // trimming client-side would slip a duplicate past this. Filed as PAY-2093.
      expect(merchants.findByLegalName).toHaveBeenCalledWith(
        '  Aurora Coffee Roasters Ltd  ',
        'gb',
      );
    });
  });

  describe('when the ledger is unavailable', () => {
    it('rethrows so the transaction rolls back — better no merchant than no accounts', async () => {
      ledger.bootstrapAccounts.mockRejectedValue(
        new LedgerUnavailableException('bootstrapAccounts', 'connect timeout'),
      );

      await expect(service.onboard(request, true, 'stf_operator')).rejects.toBeInstanceOf(
        LedgerUnavailableException,
      );
    });

    it('rethrows any other upstream failure too', async () => {
      class Weird extends Error {}
      ledger.bootstrapAccounts.mockRejectedValue(new Weird('unparseable'));

      await expect(service.onboard(request, true, 'stf_operator')).rejects.toBeInstanceOf(Weird);
    });
  });
});
