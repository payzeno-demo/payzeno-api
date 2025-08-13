/**
 * `@Roles('owner','admin')` — merchant-user roles, checked by RolesGuard against
 * `principal.role` on a `dashboard_session`.
 *
 * This is the MERCHANT's own role hierarchy. Platform operators carry `@StaffOnly()` instead;
 * conflating the two is how a merchant un-suspends itself (api-surface.md §1.2).
 *
 * Sites: POST/DELETE /v1/api-keys, POST /v1/bank-accounts, POST /v1/webhook_endpoints,
 * POST /v1/payouts, POST /v1/merchants/:id/users.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

import type { UserRole } from '@payzeno/contracts';

export const ROLES_KEY = 'payzeno:roles';

export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

/** owner ⊃ admin ⊃ developer ⊃ viewer. RolesGuard uses the rank, not set membership. */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  owner: 4,
  admin: 3,
  developer: 2,
  viewer: 1,
};

export function satisfiesRole(actual: UserRole, required: readonly UserRole[]): boolean {
  if (required.length === 0) return true;
  const needed = Math.min(...required.map((r) => ROLE_RANK[r]));
  return ROLE_RANK[actual] >= needed;
}
