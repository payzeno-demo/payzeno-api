/**
 * `@RequiredScopes('merchants:read')` — API-key scope check.
 *
 * Applies to `api_key` principals only; a session principal's permissions come from UserRole
 * instead. The vocabulary is API_KEY_SCOPES in types.ts, which is also what backs the
 * `api_key.scopes` column added by migration 19 — without a declared vocabulary that column
 * has no reader and no guard has anything to check.
 *
 * ~18 sites: every apikey-reachable handler.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

import { API_KEY_SCOPES, type ApiKeyScope } from '@payzeno/contracts';

export const REQUIRED_SCOPES_KEY = 'payzeno:required_scopes';

export const RequiredScopes = (...scopes: ApiKeyScope[]): CustomDecorator =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/** Default grant for a key created without an explicit scope list: every read scope. */
export const DEFAULT_READ_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES.filter((s) =>
  s.endsWith(':read'),
);

export function hasAllScopes(granted: readonly ApiKeyScope[], required: readonly ApiKeyScope[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

export function missingScope(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): ApiKeyScope | null {
  return required.find((scope) => !granted.includes(scope)) ?? null;
}
