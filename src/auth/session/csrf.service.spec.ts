import { CSRF_HEADER, CsrfService } from 'src/auth/session/csrf.service';
import { PermissionDeniedException } from 'src/common/errors/auth.exceptions';
import type { ApiConfig } from 'src/config/api-config.type';

/**
 * Double-submit, exactly as api-surface.md §1.3 specifies it. The spec exists because the
 * scheme has four properties and three of them look like mistakes:
 *
 *   - the cookie is NOT HttpOnly (the console has to read it to set the header);
 *   - safe methods are exempt (there is nothing to protect on a GET);
 *   - the compare is constant time (the token is a secret);
 *   - `secure` is off outside production (a Secure cookie over plain HTTP never arrives, and
 *     dev is plain HTTP).
 *
 * Anyone "fixing" the first one breaks login for every console user.
 */
describe('CsrfService', () => {
  function config(nodeEnv: 'development' | 'test' | 'production' = 'production'): ApiConfig {
    return {
      runtime: { nodeEnv },
      auth: { csrfCookieName: 'pz_csrf', csrfTtlSeconds: 86_400 },
    } as unknown as ApiConfig;
  }

  let csrf: CsrfService;

  beforeEach(() => {
    csrf = new CsrfService(config());
  });

  describe('mint', () => {
    it('produces a URL-safe token — it travels in a cookie and a header', () => {
      expect(csrf.mint()).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is NOT HttpOnly — the console reads it to populate X-Payzeno-CSRF', () => {
      expect(csrf.cookieOptions().httpOnly).toBe(false);
    });

    it('is SameSite=Lax on the root path', () => {
      expect(csrf.cookieOptions()).toMatchObject({ sameSite: 'lax', path: '/' });
    });

    it('is Secure in production', () => {
      expect(csrf.cookieOptions().secure).toBe(true);
    });

    it('is not Secure in development — dev is plain HTTP and the cookie would never arrive', () => {
      expect(new CsrfService(config('development')).cookieOptions().secure).toBe(false);
    });

    it('passes when the header matches the cookie', () => {
      expect(() => csrf.assert('POST', 'the-token', 'the-token')).not.toThrow();
    });

    it('throws permission_denied when the header is wrong', () => {
      expect(() => csrf.assert('DELETE', 'wrong', 'the-token')).toThrow(PermissionDeniedException);
    });

    it('distinguishes the two failures in details, not in the status', () => {
      const absent = catchIt(() => csrf.assert('POST', undefined, 'tok'));
      const mismatch = catchIt(() => csrf.assert('POST', 'nope-nope-nope', 'tok'));

      expect(absent?.details).toMatchObject({ reason: 'csrf_header_absent' });
      expect(mismatch?.details).toMatchObject({ reason: 'csrf_mismatch' });
      expect(absent?.httpStatus).toBe(403);
      expect(mismatch?.httpStatus).toBe(403);
    });

    it('reads the lowercase header name Node gives us', () => {
      expect(csrf.readHeader({ [CSRF_HEADER]: 'tok' })).toBe('tok');
    });

  }
}
