/**
 * SessionGuard — the console's cookie session, plus CSRF.
 *
 * CSRF is asserted inside `SessionService.resolve`, before the TTL slides and before the
 * principal exists — api-surface.md §1.3 says "checked by SessionGuard before anything else
 * runs" and this is that. A mutating request without `X-Payzeno-CSRF` is 403 even if the
 * session is perfectly valid.
 *
 * Composite routes marked `apikey | session` list ApiKeyGuard first; when a bearer token is
 * present this guard never runs, and when a cookie is present ApiKeyGuard returns null and
 * this one resolves.
 */
import { Injectable } from '@nestjs/common';

import type { AuthPrincipal } from '@payzeno/contracts';

import { CSRF_HEADER } from '../session/csrf.service';
import { SESSION_COOKIE, SessionService } from '../session/session.service';

import { BaseAuthGuard, headerValue, type AuthenticatedRequest } from './base-auth.guard';

@Injectable()
export class SessionGuard extends BaseAuthGuard {
  protected readonly scheme = 'session';

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const sessionId = this.cookie(request, SESSION_COOKIE);
    if (!sessionId) return null;

    return this.sessions.resolve(sessionId, request.method, headerValue(request.headers[CSRF_HEADER]));
  }
}
