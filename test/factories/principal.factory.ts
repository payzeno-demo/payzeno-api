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

export function makeSessionPrincipalWithRole(role: UserRole): AuthPrincipal {
  return makeSessionPrincipal({ role });
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
