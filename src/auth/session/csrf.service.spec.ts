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

    it('produces 32 bytes of randomness', () => {
      // base64url of 32 bytes is 43 characters with no padding.
      expect(csrf.mint()).toHaveLength(43);
    });

    it('never repeats', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => csrf.mint()));

      expect(tokens.size).toBe(50);
    });
  });

  describe('cookieOptions', () => {
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

    it('carries the configured 24h lifetime in milliseconds', () => {
      expect(csrf.cookieOptions().maxAge).toBe(86_400 * 1000);
    });
  });

  describe('assert', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'head'])('exempts %s', (method) => {
      expect(() => csrf.assert(method, undefined, 'expected-token')).not.toThrow();
    });

    it('passes when the header matches the cookie', () => {
      expect(() => csrf.assert('POST', 'the-token', 'the-token')).not.toThrow();
    });

    it('throws permission_denied when the header is absent', () => {
      expect(() => csrf.assert('POST', undefined, 'the-token')).toThrow(PermissionDeniedException);
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

    it('rejects a prefix of the expected token', () => {
      // A length-tolerant compare would let `t` pass against `token`.
      expect(() => csrf.assert('PATCH', 'the-tok', 'the-token')).toThrow(PermissionDeniedException);
    });

    it('rejects an empty header even when the expected token is empty', () => {
      expect(() => csrf.assert('POST', '', '')).toThrow(PermissionDeniedException);
    });
  });

  describe('readHeader', () => {
    it('reads the lowercase header name Node gives us', () => {
      expect(csrf.readHeader({ [CSRF_HEADER]: 'tok' })).toBe('tok');
    });

    it('takes the first value when a client sent the header twice', () => {
      expect(csrf.readHeader({ [CSRF_HEADER]: ['first', 'second'] })).toBe('first');
    });

    it('is undefined when absent', () => {
      expect(csrf.readHeader({})).toBeUndefined();
    });
  });

  it('exposes the configured cookie name', () => {
    expect(csrf.name).toBe('pz_csrf');
  });
});

function catchIt(fn: () => void): PermissionDeniedException | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as PermissionDeniedException;
  }
}
