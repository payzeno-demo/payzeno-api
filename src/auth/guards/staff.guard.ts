/**
 * StaffGuard — `@StaffOnly('risk' | 'finance' | 'support')`.
 *
 * `staff` is not `admin`. `admin` is the merchant's OWN owner/admin, and a platform action
 * gated on it lets a suspended merchant un-suspend itself (api-surface.md §1.2). Every route
 * in the staff table goes through here and nowhere else.
 *
 * Two responsibilities:
 *   1. resolve a `staff_session` principal (the session store's `kind: 'staff'` records), and
 *   2. check the role the handler asked for. `admin` satisfies any requirement; the other
 *      three are peers, not a ladder — a finance operator has no business accepting disputes.
 *
 * Every request that gets past this guard writes `staff_audit_log` through
 * AuditLogInterceptor. That is not optional and it is why the decorator carries the action.
 *
 * `@StaffOnly()` with no roles means "any operator": the staff session routes themselves
 * (`/v1/staff/auth/me`, `/logout`) use it, and so does every admin read all four roles share.
 */
import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthPrincipal, MerchantId, StaffRole } from '@payzeno/contracts';

import { satisfiesStaffRole, STAFF_ONLY_KEY } from '../../common/decorators/staff-only.decorator';
import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { StaffUsersService } from '../../staff/staff-users.service';
import { CSRF_HEADER } from '../session/csrf.service';
import { SessionService, STAFF_SESSION_COOKIE } from '../session/session.service';

import { BaseAuthGuard, headerValue, type AuthenticatedRequest } from './base-auth.guard';

@Injectable()
export class StaffGuard extends BaseAuthGuard {
  protected readonly scheme = 'staff';

  constructor(
    private readonly sessions: SessionService,
    private readonly staffUsers: StaffUsersService,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(STAFF_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @StaffOnly on this handler: the guard is listed but has nothing to assert. That
    // happens on the mixed controllers (SettlementsController is staff on one route and
    // session on the rest) and it is not an error.
    if (!required) return true;

    const activated = await super.canActivate(context);
    if (!activated) return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (principal?.kind !== 'staff_session') {
      throw PermissionDeniedException.staffRoleRequired(required);
    }

    if (!satisfiesStaffRole(principal.role, required)) {
      throw PermissionDeniedException.staffRoleRequired(required);
    }

    // A disabled operator keeps a live cookie until it expires; the row is the authority.
    // `resolveActive` throws PermissionDeniedException when the account is gone or disabled.
    await this.staffUsers.resolveActive(principal.staff_id);

    return true;
  }

  /** `pz_staff_session` — never the console's `pz_session` (RFC platform-v2 §1). */
  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const sessionId = this.cookie(request, STAFF_SESSION_COOKIE);
    if (!sessionId) return null;

    return this.sessions.resolveStaff(
      sessionId,
      request.method,
      headerValue(request.headers[CSRF_HEADER]),
      this.actingMerchantId(request),
    );
  }

  /** Required on every staff-marked merchant-scoped read; MerchantScopeGuard re-checks it. */
  private actingMerchantId(request: AuthenticatedRequest): MerchantId | null {
    const fromQuery = request.query.merchant_id;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

    const fromParam = request.params.merchantId;
    return fromParam ?? null;
  }
}
