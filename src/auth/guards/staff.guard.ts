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
 */
import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthPrincipal, MerchantId, StaffRole } from '@payzeno/contracts';

import { satisfiesStaffRole, STAFF_ONLY_KEY } from '../../common/decorators/staff-only.decorator';
import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { StaffUsersService } from '../../staff/staff-users.service';
import { CSRF_HEADER } from '../session/csrf.service';
import { SESSION_COOKIE, SessionService } from '../session/session.service';

import { BaseAuthGuard, headerValue, type AuthenticatedRequest } from './base-auth.guard';

@Injectable()
export class StaffGuard extends BaseAuthGuard {
  protected readonly scheme = 'staff';

  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
  }
}
