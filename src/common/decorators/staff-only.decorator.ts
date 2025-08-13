/**
 * `@StaffOnly('risk')` — a PAYZENO operator, not a merchant admin.
 *
 * The distinction is the whole reason `staff_user` exists: `admin` is the merchant's own
 * owner/admin, and a platform action gated on `admin` lets a suspended merchant un-suspend
 * itself. api-surface.md §1.2, domain-model.md §1.
 *
 * Sites: POST /v1/merchants, POST /v1/merchants/:id/status, POST /v1/disputes/:id/accept,
 * POST /v1/settlements/:b/items/:i/retry, POST /v1/webhook_events/:id/redeliver,
 * VaultClient.tokenise's route.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

import type { StaffRole } from '@payzeno/contracts';

export const STAFF_ONLY_KEY = 'payzeno:staff_only';

/** `admin` satisfies any staff requirement; the other three are peers, not a ladder. */
export const StaffOnly = (...roles: StaffRole[]): CustomDecorator => SetMetadata(STAFF_ONLY_KEY, roles);

export function satisfiesStaffRole(actual: StaffRole, required: readonly StaffRole[]): boolean {
  if (required.length === 0) return true;
  return actual === 'admin' || required.includes(actual);
}
