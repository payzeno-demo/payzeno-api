/**
 * CsrfService — double-submit, specified in one place so two agents cannot each implement
 * half of it (api-surface.md §1.3).
 *
 * The contract, verbatim:
 *
 *   - `POST /v1/auth/login` and `GET /v1/auth/me` both set `pz_csrf`: 32 random bytes,
 *     `Secure`, `SameSite=Lax`, **not** `HttpOnly`, 24h.
 *   - Every mutating request carrying a `session` principal must echo it in `X-Payzeno-CSRF`.
 *   - Mismatch or absence → `403 permission_denied`, checked by `SessionGuard` before
 *     anything else runs.
 *   - `apikey`, `internal` and `webhook-sig` requests are exempt: there is no ambient
 *     credential for a third party to ride.
 *
 * The cookie is readable on purpose. If it were HttpOnly the console could not put the value
 * in the header and the whole scheme would be a cookie compared against itself.
 */
import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';

import { ApiKeyHasher } from '../api-key/api-key.hasher';

export const CSRF_HEADER = 'x-payzeno-csrf';

/** Methods that carry no state change and are therefore exempt. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfCookieOptions {
  httpOnly: false;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

@Injectable()
export class CsrfService {
  private readonly cookieName: string;
  private readonly secureCookies: boolean;

  /** Not HttpOnly. See the header comment before "fixing" it. */
  cookieOptions(): CsrfCookieOptions {
    return {
      httpOnly: false,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: this.ttlSec * 1000,
    };
  }

  /**
   * The check `SessionGuard` runs first, before it even resolves the session. Constant-time
   * compare: the token is a secret and a timing oracle on it defeats the scheme.
   */
  assert(method: string, presented: string | undefined, expected: string): void {
    if (SAFE_METHODS.has(method.toUpperCase())) return;

    if (!presented) {
      throw new PermissionDeniedException('Missing X-Payzeno-CSRF header', {
        reason: 'csrf_header_absent',
      });
    }

    if (!ApiKeyHasher.constantTimeEquals(presented, expected)) {
      throw new PermissionDeniedException('CSRF token mismatch', { reason: 'csrf_mismatch' });
    }
  }

}
