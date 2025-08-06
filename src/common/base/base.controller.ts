/**
 * BaseController — the two things every merchant-facing controller does before it can do
 * anything else: turn an AuthPrincipal into a MerchantScope, and refuse a principal that has
 * no tenant.
 *
 * It is not a place for handlers. Nest resolves routes off the concrete class's decorators
 * and an inherited `@Get()` is a route on every subclass, which is how `/v1/refunds` once
 * answered on `/v1/disputes`.
 */
import type { ApiKeyScope, AuthPrincipal, MerchantId } from '@payzeno/contracts';

import { AuthenticationRequiredException, PermissionDeniedException } from '../errors/auth.exceptions';
import type { MerchantScope } from './merchant-scoped.entity';

export abstract class BaseController {
  /**
   * The tenant this request acts on. For a staff session it is `acting_merchant_id`, which
   * MerchantScopeGuard has already resolved from the required `?merchant_id=` parameter.
   */
  protected scopeOf(principal: AuthPrincipal): MerchantScope {
    switch (principal.kind) {
      case 'api_key':
        return { merchantId: principal.merchant_id, livemode: principal.mode === 'live' };
      case 'dashboard_session':
        return { merchantId: principal.merchant_id, livemode: true };
      case 'client_secret':
        return { merchantId: principal.merchant_id, livemode: true };
      case 'staff_session':
        if (!principal.acting_merchant_id) {
          throw new PermissionDeniedException('merchant_id is required for this staff request');
        }
        return { merchantId: principal.acting_merchant_id, livemode: true };
      case 'internal_service':
        throw new PermissionDeniedException('Internal services use the /internal/v1 surface');
    }
  }

  protected merchantIdOf(principal: AuthPrincipal): MerchantId {
    return this.scopeOf(principal).merchantId;
  }

  protected requirePrincipal(principal: AuthPrincipal | undefined | null): AuthPrincipal {
    if (!principal) throw new AuthenticationRequiredException();
    return principal;
  }

  /**
   * Belt to @RequiredScopes' braces for the handful of handlers whose required scope depends
   * on the body (a payout create is `payouts:write`, a payout list is `payouts:read`).
   */
  protected assertScope(principal: AuthPrincipal, scope: ApiKeyScope): void {
    if (principal.kind !== 'api_key') return;
    if (!principal.scopes.includes(scope)) {
      throw PermissionDeniedException.missingScope(scope);
    }
  }

  protected isStaff(principal: AuthPrincipal): boolean {
    return principal.kind === 'staff_session';
  }
}
