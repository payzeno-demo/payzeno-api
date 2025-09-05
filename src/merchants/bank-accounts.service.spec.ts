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
  it('names the aggregate', () => {
    expect(service.entityName).toBe('bank_account');
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

});
