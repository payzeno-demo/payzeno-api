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

export const READ_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES.filter((s) => s.endsWith(':read'));

export const WRITE_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES.filter((s) => s.endsWith(':write'));

/**
 * What a key gets when `CreateApiKeyRequest.scopes` is omitted: every read scope, no writes.
 * A merchant who wants to move money has to say so.
 */
export const IMPLIED_SCOPES: Readonly<Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>>> = {
  'payment_intents:write': ['payment_intents:read', 'charges:read'],
  'refunds:write': ['refunds:read'],
  'disputes:write': ['disputes:read'],
  'payouts:write': ['payouts:read', 'balance:read'],
  'webhooks:write': ['webhooks:read'],
};

/** The granted set plus everything it implies, deduplicated. */
export function expandScopes(granted: readonly ApiKeyScope[]): ApiKeyScope[] {
  const out = new Set<ApiKeyScope>(granted);
  for (const scope of granted) {
    for (const implied of IMPLIED_SCOPES[scope] ?? []) {
      out.add(implied);
    }
  }
  return [...out];
}

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export class UnknownScopeError extends Error {
  constructor(readonly unknownScopes: readonly string[]) {
    super(`Unknown API key scope(s): ${unknownScopes.join(', ')}`);
    this.name = 'UnknownScopeError';
  }
}

/** Does the expanded grant cover everything `@RequiredScopes(...)` asked for? */
export function coversRequired(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): boolean {
  if (required.length === 0) return true;
  const expanded = new Set(expandScopes(granted));
  return required.every((scope) => expanded.has(scope));
}

export function firstMissingScope(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): ApiKeyScope | null {
  const expanded = new Set(expandScopes(granted));
  return required.find((scope) => !expanded.has(scope)) ?? null;
}
