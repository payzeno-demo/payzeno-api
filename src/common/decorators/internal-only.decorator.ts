/**
 * `@InternalOnly()` — service-to-service routes.
 *
 * All six handlers of InternalController carry this AND `@UseGuards(InternalServiceGuard)`.
 * Belt and braces on purpose: the decorator is what nginx's `^/internal/` deny rule and the
 * terraform `rule_api_internal_deny` are auditing against, and the guard is what actually
 * refuses the request if both of those are misconfigured.
 *
 * api-surface.md §9b. Callers: payzeno-ledger and payzeno-billing-legacy.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const INTERNAL_ONLY_KEY = 'payzeno:internal_only';

export type InternalCaller = 'payzeno-ledger' | 'payzeno-billing-legacy';

export interface InternalOnlySpec {
  /** Empty = any authenticated internal service. Otherwise an allowlist. */
  callers: InternalCaller[];
}

export const InternalOnly = (...callers: InternalCaller[]): CustomDecorator =>
  SetMetadata(INTERNAL_ONLY_KEY, { callers } satisfies InternalOnlySpec);
