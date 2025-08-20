/**
 * The API-key scope vocabulary, as payzeno-api uses it.
 *
 * `API_KEY_SCOPES` itself is frozen in @payzeno/contracts — this file adds only the two
 * things a vocabulary needs to be usable: a default grant for a key created without an
 * explicit list (migration 19's column default is `'{}'`, which would authorise nothing),
 * and the read⊂write implication.
 *
 * ystackoverflow's first non-migration change (PAY-2071, three review rounds). The
 * implication table is the part osquash sent back twice: `payments:write` implying
 * `payments:read` is obvious, but it has to be data, not a `startsWith` on the string.
 */
import { API_KEY_SCOPES } from '@payzeno/contracts';
import type { ApiKeyScope } from '@payzeno/contracts';

export const ALL_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES;

export const IMPLIED_SCOPES: Readonly<Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>>> = {
  'payment_intents:write': ['payment_intents:read', 'charges:read'],
  'refunds:write': ['refunds:read'],
  'disputes:write': ['disputes:read'],
  'payouts:write': ['payouts:read', 'balance:read'],
  'webhooks:write': ['webhooks:read'],
};

export function firstMissingScope(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): ApiKeyScope | null {
  const expanded = new Set(expandScopes(granted));
  return required.find((scope) => !expanded.has(scope)) ?? null;
}
