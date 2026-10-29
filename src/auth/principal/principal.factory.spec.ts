import type { AuthPrincipal } from '@payzeno/contracts';

import {
  PrincipalFactory,
  describePrincipal,
  livemodeOf,
  merchantIdOf,
  optionalMerchantIdOf,
  roleOf,
  scopesOf,
  staffIdOf,
} from 'src/auth/principal/principal.factory';
import { PermissionDeniedException } from 'src/common/errors/auth.exceptions';
import type { ApiKeyEntity } from 'src/merchants/api-keys/api-key.entity';
import type { MerchantUserEntity } from 'src/merchants/users/merchant-user.entity';

/**
 * The five variants, and the reason this class exists at all: `staff_session` has no
 * `merchant_id`, only `acting_merchant_id`. Every ad-hoc principal literal that was written
 * elsewhere in the repo got that wrong, and each one let a Payzeno operator's request resolve
 * as the merchant's own admin.
 */
describe('PrincipalFactory', () => {
  const MERCHANT = 'mch_01HQ8ZZZ0000000000000001';
  const factory = new PrincipalFactory();

  const apiKeyRow = {
    id: 'ak_01HQ8ZZZAB12CD34',
    merchantId: MERCHANT,
    mode: 'test',
    scopes: ['refunds:read', 'refunds:write'],
  } as ApiKeyEntity;

  const userRow = {
    id: 'usr_01HQ8ZZZ0000000000000009',
    merchantId: MERCHANT,
    role: 'admin',
  } as MerchantUserEntity;

  describe('the five builders', () => {
    it('fromApiKey copies the mode and the scopes off the row', () => {
      expect(factory.fromApiKey(apiKeyRow)).toEqual({
        kind: 'api_key',
        merchant_id: MERCHANT,
        api_key_id: 'ak_01HQ8ZZZAB12CD34',
        mode: 'test',
        scopes: ['refunds:read', 'refunds:write'],
      });
    });

    it('fromApiKey copies the scope array rather than aliasing the entity', () => {
      const principal = factory.fromApiKey(apiKeyRow);

      (principal as { scopes: string[] }).scopes.push('payouts:write');

      // A guard that mutated the principal must not have mutated the row behind it.
      expect(apiKeyRow.scopes).toHaveLength(2);
    });

    it('fromSessionUser produces a dashboard_session with the user role', () => {
      expect(factory.fromSessionUser(userRow)).toEqual({
        kind: 'dashboard_session',
        merchant_id: MERCHANT,
        user_id: 'usr_01HQ8ZZZ0000000000000009',
        role: 'admin',
      });
    });

    it('fromSessionRecord matches fromSessionUser for the same subject', () => {
      expect(factory.fromSessionRecord(MERCHANT, userRow.id, 'admin')).toEqual(
        factory.fromSessionUser(userRow),
      );
    });

    it('fromStaff carries acting_merchant_id and no merchant_id at all', () => {
      const principal = factory.fromStaff('stf_0001', 'risk', MERCHANT);

      expect(principal).toEqual({
        kind: 'staff_session',
        staff_id: 'stf_0001',
        role: 'risk',
        acting_merchant_id: MERCHANT,
      });
      expect(principal).not.toHaveProperty('merchant_id');
    });

    it('fromStaff allows a null acting merchant — POST /v1/merchants has no merchant yet', () => {
      expect(factory.fromStaff('stf_0001', 'risk', null).kind).toBe('staff_session');
    });

    it('fromInternalService defaults to no scopes', () => {
      expect(factory.fromInternalService('payzeno-ledger')).toEqual({
        kind: 'internal_service',
        service: 'payzeno-ledger',
        scopes: [],
      });
    });

    it('fromClientSecret pins the principal to exactly one intent', () => {
      expect(factory.fromClientSecret(MERCHANT, 'pi_01HQ8ZZZ0000000000000002', true)).toEqual({
        kind: 'client_secret',
        merchant_id: MERCHANT,
        payment_intent_id: 'pi_01HQ8ZZZ0000000000000002',
        livemode: true,
      });
    });
  });

  describe('merchantIdOf', () => {
    it.each([
      ['api_key', factory.fromApiKey(apiKeyRow)],
      ['dashboard_session', factory.fromSessionUser(userRow)],
      ['client_secret', factory.fromClientSecret(MERCHANT, 'pi_01HQ8ZZZ0000000000000002', true)],
    ])('reads merchant_id off a %s principal', (_kind, principal) => {
      expect(merchantIdOf(principal as AuthPrincipal)).toBe(MERCHANT);
    });

    it('reads acting_merchant_id off a staff principal', () => {
      expect(merchantIdOf(factory.fromStaff('stf_0001', 'support', MERCHANT))).toBe(MERCHANT);
    });

    it('throws when a staff principal named no merchant', () => {
      expect(() => merchantIdOf(factory.fromStaff('stf_0001', 'support', null))).toThrow(
        PermissionDeniedException,
      );
    });

    it('throws for an internal service — /v1 is not its surface', () => {
      expect(() => merchantIdOf(factory.fromInternalService('payzeno-ledger'))).toThrow(
        PermissionDeniedException,
      );
    });
  });

  describe('optionalMerchantIdOf', () => {
    it('is null rather than a throw for a staff principal with no merchant', () => {
      expect(optionalMerchantIdOf(factory.fromStaff('stf_0001', 'finance', null))).toBeNull();
    });

    it('is null for an absent principal — interceptors run before the guards', () => {
      expect(optionalMerchantIdOf(undefined)).toBeNull();
      expect(optionalMerchantIdOf(null)).toBeNull();
    });

    it('is null for an internal service', () => {
      expect(optionalMerchantIdOf(factory.fromInternalService('payzeno-billing-legacy'))).toBeNull();
    });
  });

  describe('livemodeOf', () => {
    it('follows the key mode for an api_key principal', () => {
      expect(livemodeOf(factory.fromApiKey(apiKeyRow))).toBe(false);
      expect(livemodeOf(factory.fromApiKey({ ...apiKeyRow, mode: 'live' } as ApiKeyEntity))).toBe(true);
    });

    it('is true for a dashboard session — the console switches mode with a sk_test_ key', () => {
      expect(livemodeOf(factory.fromSessionUser(userRow))).toBe(true);
    });

    it('is true for staff and internal principals', () => {
      expect(livemodeOf(factory.fromStaff('stf_0001', 'risk', MERCHANT))).toBe(true);
      expect(livemodeOf(factory.fromInternalService('payzeno-ledger'))).toBe(true);
    });

    // Regression: a client secret used to read as live whatever its intent was, so a test-mode
    // checkout could never find its own (test-mode) intent.
    it('takes a client secret principal\'s mode from the intent it was minted for', () => {
      expect(livemodeOf(factory.fromClientSecret(MERCHANT, 'pi_1', true))).toBe(true);
      expect(livemodeOf(factory.fromClientSecret(MERCHANT, 'pi_1', false))).toBe(false);
    });
  });

  describe('the field accessors', () => {
    it('staffIdOf is the id for staff and null for everything else', () => {
      expect(staffIdOf(factory.fromStaff('stf_0001', 'risk', null))).toBe('stf_0001');
      expect(staffIdOf(factory.fromSessionUser(userRow))).toBeNull();
    });

    it('scopesOf is empty for anything that is not an api key', () => {
      expect(scopesOf(factory.fromApiKey(apiKeyRow))).toHaveLength(2);
      expect(scopesOf(factory.fromSessionUser(userRow))).toEqual([]);
    });

    it('roleOf is the merchant role only, never the staff role', () => {
      expect(roleOf(factory.fromSessionUser(userRow))).toBe('admin');
      expect(roleOf(factory.fromStaff('stf_0001', 'risk', null))).toBeNull();
    });
  });

  describe('describePrincipal', () => {
    it.each([
      ['anonymous', null],
      ['api_key:ak_01HQ8ZZZAB12CD34', factory.fromApiKey(apiKeyRow)],
      ['user:usr_01HQ8ZZZ0000000000000009', factory.fromSessionUser(userRow)],
      ['staff:stf_0001', factory.fromStaff('stf_0001', 'risk', null)],
      ['service:payzeno-ledger', factory.fromInternalService('payzeno-ledger')],
      ['client_secret:pi_1', factory.fromClientSecret(MERCHANT, 'pi_1', true)],
    ])('renders %s', (expected, principal) => {
      expect(describePrincipal(principal as AuthPrincipal | null)).toBe(expected);
    });

    it('never includes a secret — it goes straight into the access log', () => {
      const line = describePrincipal(factory.fromApiKey(apiKeyRow));

      expect(line).not.toContain('sk_');
      expect(line).not.toContain(apiKeyRow.scopes.join(''));
    });
  });
});
