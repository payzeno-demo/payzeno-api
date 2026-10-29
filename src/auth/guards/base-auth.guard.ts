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
import { GUARDS_METADATA } from '@nestjs/common/constants';

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
   * Resolve or throw. Returning null means "no credential of my kind was presented": the base
   * hands the request to the next credential guard in the chain, or answers 401 when there is
   * none left. Subclasses that want a different message throw instead.
   */
  protected abstract authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null>;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // A previous guard in the same @UseGuards() list already authenticated this request.
    // The composite `apikey | session` routes rely on this: whichever guard matches, wins.
    if (request.principal) return true;

    const principal = this.appliesTo(context) ? await this.authenticate(request) : null;

    if (!principal) {
      // Composite routes list one guard per accepted scheme (`apikey | session`, plus
      // `client-secret` on confirm). A credential of THIS kind being absent is only fatal when
      // no later guard in the chain is left to try — otherwise ApiKeyGuard would 401 every
      // console request before SessionGuard ever saw its cookie.
      if (hasLaterCredentialGuard(context, this)) return true;

      throw new AuthenticationRequiredException(`No ${this.scheme} credential presented`, {
        scheme: this.scheme,
      });
    }

    this.attach(request, principal);
    return true;
  }

  /**
   * Whether this scheme is accepted on the handler at all. Only ClientSecretGuard narrows it
   * (`@AcceptsClientSecret()`); a scheme that does not apply behaves exactly as if its
   * credential were absent.
   */
  protected appliesTo(_context: ExecutionContext): boolean {
    return true;
  }

  protected attach(request: AuthenticatedRequest, principal: AuthPrincipal): void {
    request.principal = principal;
    attachPrincipal(principal);
  }

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

  protected header(request: AuthenticatedRequest, name: string): string | undefined {
    return headerValue(request.headers[name.toLowerCase()]);
  }
}

export function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * True when a credential guard listed after `guard` in this handler's chain can still
 * authenticate the request. Nest runs controller-level `@UseGuards` before method-level ones,
 * each in list order, so that is the order reconstructed here.
 */
export function hasLaterCredentialGuard(context: ExecutionContext, guard: BaseAuthGuard): boolean {
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, context.getClass()) ?? [];
  const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, context.getHandler()) ?? [];
  const chain = [...classGuards, ...handlerGuards];

  const position = chain.findIndex((entry) => entry === guard || entry === guard.constructor);
  if (position === -1) return false;

  return chain.slice(position + 1).some(isCredentialGuard);
}

function isCredentialGuard(entry: unknown): boolean {
  if (entry instanceof BaseAuthGuard) return true;
  return typeof entry === 'function' && entry.prototype instanceof BaseAuthGuard;
}
