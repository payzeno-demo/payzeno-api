import { API_KEY_SCOPES } from '@payzeno/contracts';
import {
  TEST_API_KEY_ID,
  TEST_MERCHANT_ID,
  TEST_PAYMENT_INTENT_ID,
  TEST_USER_ID,
  fixedId,
} from './ids';
import type {
  ApiKeyScope,
  AuthPrincipal,
  MerchantId,
  StaffRole,
  UserRole,
} from '@payzeno/contracts';

/**
 * The five `AuthPrincipal` variants, one builder each. Production builds them in
 * `PrincipalFactory` (`src/auth/principal/principal.factory.ts`); the guards' specs
 * need them without booting the whole auth stack.
 *
 * The variants are not interchangeable and the specs depend on that: `staff_session`
 * has no `merchant_id`, only `acting_merchant_id`, which is exactly why
 * `MerchantScopeGuard` needs a branch for it.
 */

export function makeApiKeyPrincipal(
  overrides: Partial<Extract<AuthPrincipal, { kind: 'api_key' }>> = {},
): AuthPrincipal {
  return {
    kind: 'api_key',
    merchant_id: TEST_MERCHANT_ID,
    api_key_id: TEST_API_KEY_ID,
    mode: 'live',
    scopes: [...API_KEY_SCOPES],
    ...overrides,
  };
}

/** An api-key principal holding exactly the scopes given — for `@RequiredScopes` specs. */
export function makeScopedApiKeyPrincipal(
  scopes: ApiKeyScope[],
  merchantId: MerchantId = TEST_MERCHANT_ID,
): AuthPrincipal {
  return makeApiKeyPrincipal({ merchant_id: merchantId, scopes });
}

export function makeSessionPrincipal(
  overrides: Partial<Extract<AuthPrincipal, { kind: 'dashboard_session' }>> = {},
): AuthPrincipal {
  return {
    kind: 'dashboard_session',
    merchant_id: TEST_MERCHANT_ID,
    user_id: TEST_USER_ID,
    role: 'owner',
    ...overrides,
  };
}

export function makeSessionPrincipalWithRole(role: UserRole): AuthPrincipal {
  return makeSessionPrincipal({ role });
}

export function makeStaffPrincipal(
  overrides: Partial<Extract<AuthPrincipal, { kind: 'staff_session' }>> = {},
): AuthPrincipal {
  return {
    kind: 'staff_session',
    staff_id: fixedId('stf_', 'payzeno-operator'),
    role: 'support',
    acting_merchant_id: null,
    ...overrides,
  };
}

/** `POST /v1/settlements/:b/items/:i/retry` is `@StaffOnly('finance')` and livemode-only. */
export function makeFinanceStaffPrincipal(actingMerchantId: MerchantId | null = null): AuthPrincipal {
  return makeStaffPrincipal({ role: 'finance', acting_merchant_id: actingMerchantId });
}

export function makeStaffPrincipalWithRole(
  role: StaffRole,
  actingMerchantId: MerchantId | null = TEST_MERCHANT_ID,
): AuthPrincipal {
  return makeStaffPrincipal({ role, acting_merchant_id: actingMerchantId });
}

export function makeInternalPrincipal(
  overrides: Partial<Extract<AuthPrincipal, { kind: 'internal_service' }>> = {},
): AuthPrincipal {
  return {
    kind: 'internal_service',
    service: 'payzeno-ledger',
    scopes: ['internal:read', 'internal:write'],
    ...overrides,
  };
}

export function makeClientSecretPrincipal(
  overrides: Partial<Extract<AuthPrincipal, { kind: 'client_secret' }>> = {},
): AuthPrincipal {
  return {
    kind: 'client_secret',
    merchant_id: TEST_MERCHANT_ID,
    payment_intent_id: TEST_PAYMENT_INTENT_ID,
    livemode: true,
    ...overrides,
  };
}

/** Every variant, for the guards' "rejects the wrong principal kind" tables. */
export function allPrincipalKinds(): AuthPrincipal[] {
  return [
    makeApiKeyPrincipal(),
    makeSessionPrincipal(),
    makeStaffPrincipal(),
    makeInternalPrincipal(),
    makeClientSecretPrincipal(),
  ];
}
