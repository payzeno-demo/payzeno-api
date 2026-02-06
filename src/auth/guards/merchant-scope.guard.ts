/**
 * MerchantScopeGuard — the tenant boundary.
 *
 * Every authenticated route passes through it. Four checks, in this order:
 *
 *   1. the controller declared `@MerchantScoped()`. If it did not, the guard refuses to run
 *      on it — forgetting the decorator fails closed rather than serving another tenant.
 *   2. a staff principal named a merchant (`?merchant_id=` or `:merchantId`). Without one
 *      there is no scope to check and the read would be platform-wide.
 *   3. the path's `:merchantId`, when present, IS the principal's merchant. A mismatch is
 *      **404 not_found**, never 403 — confirming a resource exists but belongs to somebody
 *      else leaks tenant membership (api-surface.md §1.2).
 *   4. `@LivemodeOnly()` handlers refuse a test-mode principal, and a `restricted` or
 *      `suspended` merchant cannot reach a mutating handler at all.
 *
 * Check 4's merchant read is the only database hit in the guard, and it is skipped entirely
 * for safe methods — a GET does not care whether the merchant is restricted, and adding a
 * SELECT to every list request to find out is how the console's dashboard got slow.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthPrincipal, MerchantId } from '@payzeno/contracts';

import { LIVEMODE_ONLY_KEY } from '../../common/decorators/livemode-only.decorator';
import {
  MERCHANT_SCOPED_KEY,
  type MerchantScopedOptions,
} from '../../common/decorators/merchant-scoped.decorator';
import { AuthenticationRequiredException, PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { MerchantRestrictedException } from '../../common/errors/business.exceptions';
import { MerchantNotFoundException } from '../../common/errors/not-found.exceptions';
import { setLivemode } from '../../common/logging/request-context';
import { MerchantRepository } from '../../merchants/merchant.repository';
import { livemodeOf, optionalMerchantIdOf } from '../principal/principal.factory';

import type { AuthenticatedRequest } from './base-auth.guard';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Statuses that may still read but may not write. domain-model.md §1 lifecycle. */
const WRITE_BLOCKED_STATUSES = new Set(['suspended', 'rejected', 'closed']);

@Injectable()
export class MerchantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (!principal) throw new AuthenticationRequiredException();

    const merchantId = this.resolveScope(principal, options);
    this.assertPathMatches(request, merchantId);
    this.assertLivemode(context, principal);

    setLivemode(livemodeOf(principal));

    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      await this.assertWritable(merchantId, request.method);
    }

    return true;
  }

  private resolveScope(principal: AuthPrincipal, options: MerchantScopedOptions): MerchantId {
    const pathMerchantId = request.params.merchantId;
    if (pathMerchantId && pathMerchantId !== merchantId) {
      throw new MerchantNotFoundException(pathMerchantId);
    }
  }

  private assertLivemode(context: ExecutionContext, principal: AuthPrincipal): void {
    const livemodeOnly = this.reflector.getAllAndOverride<boolean | undefined>(LIVEMODE_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!livemodeOnly) return;
    if (livemodeOf(principal)) return;

    throw new PermissionDeniedException('This route is not available in test mode', {
      reason: 'livemode_only',
    });
  }

  private async assertWritable(merchantId: MerchantId, method: string): Promise<void> {
    const merchant = await this.merchants.findById(merchantId);

    if (!merchant) throw new MerchantNotFoundException(merchantId);

    if (WRITE_BLOCKED_STATUSES.has(merchant.status)) {
      throw new MerchantRestrictedException(
        merchantId,
        `merchant status ${merchant.status} may not ${method.toUpperCase()}`,
      );
    }
  }
}
