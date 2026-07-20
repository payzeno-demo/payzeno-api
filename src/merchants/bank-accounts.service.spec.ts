import type { EntityManager } from 'typeorm';

import type { CreateBankAccountRequest } from '@payzeno/contracts';

import type { MerchantScope } from 'src/common/base/merchant-scoped.entity';
import { ValidationException } from 'src/common/errors/api.exception';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { EventPublisher } from 'src/events/publisher';
import {
  BankAccountsService,
  type BankAccountRepository,
} from 'src/merchants/bank-accounts/bank-accounts.service';

import { TEST_MERCHANT_ID, fixedId } from 'test/factories/ids';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * Three rules, all of which exist because a payout that is wrong comes back three days later
 * with a fee attached:
 *
 *   1. scheme ↔ currency. A GBP account on the SEPA rail is a returned payout, and the
 *      merchant only finds out after the money has left.
 *   2. exactly one default PER CURRENCY. `pix_bank_account_default` is a partial unique
 *      index; setting the new default before clearing the old one fails every time.
 *   3. `merchant.bank_account_verified` must be emitted, or payzeno-ledger holds a
 *      `payout.bank_account_id` it cannot resolve and `PayoutInitiator` has no token to hand
 *      the rail.
 */
describe('BankAccountsService', () => {
  const clock = new FixedClock('2026-04-10T09:00:00.000Z');
  const scope: MerchantScope = { merchantId: TEST_MERCHANT_ID, livemode: true };
  const BANK_ACCOUNT_ID = fixedId('ba_', 'aurora-gbp');

  const request: CreateBankAccountRequest = {
    country: 'gb',
    currency: 'GBP',
    scheme: 'uk_sort_code',
    bank_account_token: 'bat_9f2c1a7e',
    account_holder_name: '  Aurora Coffee Roasters Ltd  ',
    is_default: true,
  };

  let accounts: {
    insertMapped: jest.Mock;
    clearDefault: jest.Mock;
    markDefault: jest.Mock;
    findScoped: jest.Mock;
    findOne: jest.Mock;
    paginateCursor: jest.Mock;
  };
  let transactions: TransactionManager;
  function storedAccount(overrides: Record<string, unknown> = {}) {
    const account = {
      id: BANK_ACCOUNT_ID,
      merchantId: TEST_MERCHANT_ID,
      currency: 'GBP',
      scheme: 'uk_sort_code',
      status: 'validated',
      isDefault: false,
      livemode: true,
      isPayable: () => account.status === 'validated',
      toBankAccount: () => ({
        id: BANK_ACCOUNT_ID,
        object: 'bank_account' as const,
        merchant_id: TEST_MERCHANT_ID,
        country: 'GB',
        currency: 'GBP' as const,
        bank_name: 'Pending validation',
        scheme: 'uk_sort_code' as const,
        last_four: '0000',
        routing_last_four: null,
        iban_last_four: null,
        bic: null,
        sort_code_last_four: null,
        status: account.status as 'validated',
        is_default: account.isDefault,
        livemode: true,
        created_at: '2026-04-10T09:00:00.000Z',
      }),
      ...overrides,
    };
    return account;
  }

  beforeEach(() => {
    accounts = {
      insertMapped: jest.fn().mockResolvedValue(undefined),
      clearDefault: jest.fn().mockResolvedValue(undefined),
      markDefault: jest.fn().mockResolvedValue(undefined),
      findScoped: jest.fn().mockResolvedValue(storedAccount()),
      findOne: jest.fn().mockResolvedValue(storedAccount()),
      paginateCursor: jest
        .fn()
        .mockResolvedValue({ data: [storedAccount()], has_more: false, next_cursor: null }),
    };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    transactions = {
      runInTransaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) =>
        cb({} as EntityManager),
      ),
    } as unknown as TransactionManager;

    service = new BankAccountsService(
      accounts as unknown as BankAccountRepository,
      transactions,
      new IdFactory(),
      events as unknown as EventPublisher,
      clock,
      new NoopLogger(),
    );
  });

  it('names the aggregate', () => {
    expect(service.entityName).toBe('bank_account');
  });

  describe('scheme ↔ currency', () => {
    it.each([
      ['aba', 'USD'],
      ['iban', 'EUR'],
      ['uk_sort_code', 'GBP'],
    ] as const)('accepts a %s account settling %s', async (scheme, currency) => {
      await expect(
        service.create(scope, { ...request, scheme, currency }),
      ).resolves.toMatchObject({ object: 'bank_account' });
    });

    it.each([
      ['uk_sort_code', 'EUR'],
      ['iban', 'GBP'],
      ['aba', 'JPY'],
      ['iban', 'USD'],
    ] as const)('rejects a %s account settling %s before anything is written', async (scheme, currency) => {
      await expect(service.create(scope, { ...request, scheme, currency })).rejects.toBeInstanceOf(
        ValidationException,
      );

      expect(accounts.insertMapped).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('tells the merchant which currencies the rail actually settles', async () => {
      try {
        await service.create(scope, { ...request, scheme: 'iban', currency: 'GBP' });
        throw new Error('expected a ValidationException');
      } catch (err) {
        const [fieldError] = (err as ValidationException).fieldErrors;
        expect(fieldError).toMatchObject({ path: 'scheme', code: 'scheme_currency_mismatch' });
        expect(fieldError.message).toContain('EUR');
      }
    });
  });

  describe('create', () => {
    it('clears the previous default in the same transaction before inserting', async () => {
      await service.create(scope, request);

      const clearOrder = accounts.clearDefault.mock.invocationCallOrder[0];
      const insertOrder = accounts.insertMapped.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(insertOrder);
      expect(accounts.clearDefault).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'GBP',
        true,
        expect.anything(),
      );
    });

    it('does not touch the existing default when the new account is not one', async () => {
      await service.create(scope, { ...request, is_default: false });

      expect(accounts.clearDefault).not.toHaveBeenCalled();
    });

    it('stores only the vault token, never an account number', async () => {
      await service.create(scope, request);

      const [row] = accounts.insertMapped.mock.calls[0];
      expect(row.accountNumberToken).toBe('bat_9f2c1a7e');
      expect(row.lastFour).toBeNull();
      expect(row.routingLastFour).toBeNull();
      expect(row.sortCodeLastFour).toBeNull();
    });

    it('normalises the country and trims the holder name', async () => {
      await service.create(scope, request);

      const [row] = accounts.insertMapped.mock.calls[0];
      expect(row.country).toBe('GB');
      expect(row.accountHolderName).toBe('Aurora Coffee Roasters Ltd');
    });

    it('starts the account as new — validation happens on the vault callback', async () => {
      await service.create(scope, request);

      expect(accounts.insertMapped.mock.calls[0][0].status).toBe('new');
    });

    it('emits merchant.bank_account_verified carrying the token the ledger needs', async () => {
      await service.create(scope, request);

      const [type, payload, context] = events.publish.mock.calls[0];
      expect(type).toBe('merchant.bank_account_verified');
      expect(payload).toMatchObject({
        merchant_id: TEST_MERCHANT_ID,
        currency: 'GBP',
        scheme: 'uk_sort_code',
        account_number_token: 'bat_9f2c1a7e',
      });
      expect(context).toMatchObject({ livemode: true });
    });
  });

  describe('getForInternal', () => {
    it('reads unscoped — it is the ledger’s stale-projection fallback', async () => {
      await service.getForInternal(BANK_ACCOUNT_ID);

      expect(accounts.findOne).toHaveBeenCalledWith({ where: { id: BANK_ACCOUNT_ID } });
    });

    it('404s an unknown id', async () => {
      accounts.findOne.mockResolvedValue(null);

      await expect(service.getForInternal(BANK_ACCOUNT_ID)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });
});
