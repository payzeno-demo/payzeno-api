/**
 * RolesGuard — the merchant's own role hierarchy, `owner ⊃ admin ⊃ developer ⊃ viewer`.
 *
 * Runs after the auth guard, so a principal is already attached. It only has an opinion about
 * `dashboard_session` principals:
 *
 *   api_key        → scopes decide, and ApiKeyGuard already checked them. A key is not a
 *                    person and has no role.
 *   staff_session  → StaffGuard decides. A Payzeno operator outranks every merchant role by
 *                    construction, and making `staff` pass a merchant role check would mean
 *                    inventing a merchant role for them.
 *   client_secret  → never. Nothing role-gated is reachable with a browser credential.
 *
 * Sites: POST/DELETE /v1/api-keys, POST /v1/bank-accounts, POST /v1/webhook_endpoints,
 * POST /v1/payouts, POST /v1/merchants/:id/users.
 */
import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '@payzeno/contracts';

import { ROLES_KEY, satisfiesRole } from '../../common/decorators/roles.decorator';
import { AuthenticationRequiredException, PermissionDeniedException } from '../../common/errors/auth.exceptions';

import type { AuthenticatedRequest } from './base-auth.guard';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (!principal) throw new AuthenticationRequiredException();

    switch (principal.kind) {
      case 'dashboard_session':
        if (!satisfiesRole(principal.role, required)) {
          throw new PermissionDeniedException(
            `This action requires the ${required.join(' or ')} role`,
            { role: principal.role, required: required.join(',') },
          );
        }
        return true;

