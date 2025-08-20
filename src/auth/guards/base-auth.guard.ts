/**
 * BaseAuthGuard — the shared shape of every credential guard.
 *
 * Five concretes: ApiKeyGuard, SessionGuard, ClientSecretGuard, StaffGuard,
 * InternalServiceGuard. Each supplies exactly one thing — how to turn this request into an
 * `AuthPrincipal` — and inherits the rest:
 *
 *   1. `@Public()`-free: every route reaching a guard needs a credential.
 *   2. attach the principal to the request AND to the AsyncLocalStorage context, so the
 *      logger, the audit interceptor and the outbox publisher all see the same actor.
 *   3. one 401 shape. `AuthenticationRequiredException` when nothing was presented,
 *      the subclass's own exception when something was and it did not resolve.
 *
 * Order in the chain (api-surface.md §1.5): RateLimitGuard → auth guard → MerchantScopeGuard
 * → RolesGuard/StaffGuard. A guard here can assume rate limiting already happened and must
 * not assume anything about scope.
 */
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { AuthPrincipal } from '@payzeno/contracts';

import { AuthenticationRequiredException } from '../../common/errors/auth.exceptions';
import { attachPrincipal } from '../../common/logging/request-context';

export interface AuthenticatedRequest {
  method: string;
  url: string;
  originalUrl?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  principal?: AuthPrincipal;
}

export abstract class BaseAuthGuard implements CanActivate {
  /** For log lines and for the `WWW-Authenticate`-ish hint in the 401 details. */
  protected abstract readonly scheme: string;

  /**
   * Resolve or throw. Returning null means "no credential of my kind was presented", which
   * the base turns into a 401 — subclasses that want a different message throw instead.
   */
  /** `Authorization: Bearer <token>` → `<token>`. Case-insensitive on the scheme, per RFC. */
  protected bearerToken(request: AuthenticatedRequest): string | null {
    const header = headerValue(request.headers.authorization);
    if (!header) return null;

    const [scheme, ...rest] = header.split(' ');
    if (scheme.toLowerCase() !== 'bearer' || rest.length === 0) return null;

    const token = rest.join(' ').trim();
    return token.length > 0 ? token : null;
  }

  protected cookie(request: AuthenticatedRequest, name: string): string | undefined {
    return request.cookies?.[name];
  }

}
