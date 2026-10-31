/**
 * PrincipalFactory — the one place an `AuthPrincipal` is constructed.
 *
 * Five variants (types.ts §Auth context), five builders, and no other file in the repo is
 * allowed to write an object literal with a `kind` field. The reason is `staff_session`: it
 * has no `merchant_id`, only `acting_merchant_id`, and every ad-hoc construction of a
 * principal somewhere else in the codebase was an ad-hoc construction that got that wrong and
 * let a Payzeno operator's request resolve as the merchant's own admin.
 *
 * The free functions below (`merchantIdOf`, `livemodeOf`, `staffIdOf`) are what controllers
 * and interceptors use. They are here rather than on the class because a controller taking a
 * `PrincipalFactory` dependency to read a field off a value it already has is noise.
 */
import { Injectable } from '@nestjs/common';

import type {
  ApiKeyMode,
  ApiKeyScope,
  AuthPrincipal,
  MerchantId,
  PaymentIntentId,
  StaffRole,
  UserId,
  UserRole,
} from '@payzeno/contracts';

import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import type { ApiKeyEntity } from '../../merchants/api-keys/api-key.entity';
import type { MerchantUserEntity } from '../../merchants/users/merchant-user.entity';

export type InternalCallerService = 'payzeno-ledger' | 'payzeno-billing-legacy';

@Injectable()
export class PrincipalFactory {
  /** ApiKeyGuard, after ApiKeyResolver has verified the secret against `secret_hash`. */
  fromApiKey(apiKey: ApiKeyEntity): AuthPrincipal {
    return {
      kind: 'api_key',
      merchant_id: apiKey.merchantId,
      api_key_id: apiKey.id,
      mode: apiKey.mode as ApiKeyMode,
      scopes: [...apiKey.scopes] as ApiKeyScope[],
    };
  }

  /** SessionGuard, after SessionService has resolved the `pz_session` cookie. */
  fromSessionUser(user: MerchantUserEntity): AuthPrincipal {
    return {
      kind: 'dashboard_session',
      merchant_id: user.merchantId,
      user_id: user.id,
      role: user.role as UserRole,
    };
  }

  fromSessionRecord(merchantId: MerchantId, userId: UserId, role: UserRole): AuthPrincipal {
    return { kind: 'dashboard_session', merchant_id: merchantId, user_id: userId, role };
  }

  /**
   * StaffGuard. `actingMerchantId` comes from the required `?merchant_id=` query parameter on
   * every staff-marked merchant-scoped read (api-surface.md §1.2) and is null for the
   * platform-wide routes (`POST /v1/merchants` has no merchant yet).
   */
  fromStaff(staffId: string, role: StaffRole, actingMerchantId: MerchantId | null): AuthPrincipal {
    return {
      kind: 'staff_session',
      staff_id: staffId,
      role,
      acting_merchant_id: actingMerchantId,
    };
  }

  /** InternalServiceGuard, after the shared-secret and `X-Payzeno-Service` checks pass. */
  fromInternalService(service: InternalCallerService, scopes: string[] = []): AuthPrincipal {
    return { kind: 'internal_service', service, scopes };
  }

  /** ClientSecretGuard. Scoped to exactly one PaymentIntent — no merchant-wide read. */
  fromClientSecret(merchantId: MerchantId, paymentIntentId: PaymentIntentId, livemode: boolean): AuthPrincipal {
    return { kind: 'client_secret', merchant_id: merchantId, payment_intent_id: paymentIntentId, livemode };
  }
}

/**
 * The tenant this principal acts on.
 *
 * Throws rather than returning null: every caller is a merchant-scoped handler that has
 * nothing sensible to do without a tenant, and an `internal_service` principal reaching a
 * `/v1/` route is a routing bug, not a permission the caller can be told about.
 */
export function merchantIdOf(principal: AuthPrincipal): MerchantId {
  switch (principal.kind) {
    case 'api_key':
    case 'dashboard_session':
    case 'client_secret':
      return principal.merchant_id;
    case 'staff_session':
      if (!principal.acting_merchant_id) {
        throw new PermissionDeniedException(
          'merchant_id is required on staff requests to a merchant-scoped route',
          { staff_id: principal.staff_id },
        );
      }
      return principal.acting_merchant_id;
    case 'internal_service':
      throw new PermissionDeniedException('Internal services must use the /internal/v1 surface', {
        service: principal.service,
      });
  }
}

/** Null-tolerant form, for the interceptors that run before a guard may have attached one. */
export function optionalMerchantIdOf(principal: AuthPrincipal | undefined | null): MerchantId | null {
  if (!principal) return null;
  switch (principal.kind) {
    case 'api_key':
    case 'dashboard_session':
    case 'client_secret':
      return principal.merchant_id;
    case 'staff_session':
      return principal.acting_merchant_id;
    case 'internal_service':
      return null;
  }
}

/**
 * Live vs test. Only an API key carries the distinction natively; a dashboard session is
 * always live, because the console switches mode by presenting a `sk_test_` key to the
 * sandbox surface rather than by flipping a session field.
 */
export function livemodeOf(principal: AuthPrincipal): boolean {
  switch (principal.kind) {
    case 'api_key':
      return principal.mode === 'live';
    case 'client_secret':
      // The intent's mode, stamped by ClientSecretGuard / CheckoutSecretGuard off the row.
      return principal.livemode;
    case 'dashboard_session':
    case 'staff_session':
      return true;
    case 'internal_service':
      return true;
  }
}

/** `staff_audit_log.staff_id`, and `RetryReconciliationItemRequest.requested_by`. */
export function staffIdOf(principal: AuthPrincipal): string | null {
  return principal.kind === 'staff_session' ? principal.staff_id : null;
}

export function scopesOf(principal: AuthPrincipal): readonly ApiKeyScope[] {
  return principal.kind === 'api_key' ? principal.scopes : [];
}

export function roleOf(principal: AuthPrincipal): UserRole | null {
  return principal.kind === 'dashboard_session' ? principal.role : null;
}

/** One line, safe to log. Used by StructuredLoggerMiddleware and the audit interceptor. */
export function describePrincipal(principal: AuthPrincipal | null): string {
  if (!principal) return 'anonymous';
  switch (principal.kind) {
    case 'api_key':
      return `api_key:${principal.api_key_id}`;
    case 'dashboard_session':
      return `user:${principal.user_id}`;
    case 'staff_session':
      return `staff:${principal.staff_id}`;
    case 'internal_service':
      return `service:${principal.service}`;
    case 'client_secret':
      return `client_secret:${principal.payment_intent_id}`;
  }
}
