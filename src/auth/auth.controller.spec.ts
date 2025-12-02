import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import {
  AuthController,
  LoginRequestDto,
  PasswordResetRequestDto,
  type CookieResponse,
} from 'src/auth/auth.controller';
import type { AuthService } from 'src/auth/auth.service';
import type { AuthenticatedRequest } from 'src/auth/guards/base-auth.guard';
import { SESSION_COOKIE, type SessionService } from 'src/auth/session/session.service';
import { AuthenticationRequiredException } from 'src/common/errors/auth.exceptions';

/**
 * The cookie contract is the thing under test. Everything else in this controller delegates,
 * but the flags on `pz_session` and `pz_csrf` live here and getting either wrong is a silent
 * break: an HttpOnly `pz_csrf` means the console cannot fill `X-Payzeno-CSRF` and every
 * mutation 403s, and a non-HttpOnly `pz_session` means a single XSS is a session handover.
 */
describe('AuthController', () => {
  let auth: jest.Mocked<Pick<AuthService, 'login' | 'logout' | 'describeSession' | 'requestPasswordReset'>>;
  let sessions: jest.Mocked<Pick<SessionService, 'expiredCookies' | 'csrfCookieOptions'>> & {
    csrfCookieName: string;
  };
  let response: jest.Mocked<CookieResponse>;
  let controller: AuthController;

  const issued = {
    record: { id: 'sess_1' },
    sessionCookie: {
      name: SESSION_COOKIE,
      value: 'sess_1',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 43_200_000 },
    },
    csrfCookie: {
      name: 'pz_csrf',
      value: 'csrf-token',
      options: { httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: 86_400_000 },
    },
  };

  function request(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
    return {
      method: 'POST',
      url: '/v1/auth/login',
      ip: '203.0.113.7',
      headers: { 'user-agent': 'Mozilla/5.0' },
      cookies: {},
      params: {},
      query: {},
      ...overrides,
    } as AuthenticatedRequest;
  }

  beforeEach(() => {
    auth = {
      login: jest.fn(async () => ({ issued, body: { object: 'login' } })),
      logout: jest.fn(async () => undefined),
      describeSession: jest.fn(async () => ({
        csrfToken: 'fresh-csrf',
        body: { object: 'session' },
      })),
      requestPasswordReset: jest.fn(async () => undefined),
    } as never;

    sessions = {
      expiredCookies: jest.fn(() => [
        { name: SESSION_COOKIE, value: '', options: { path: '/', maxAge: 0 } },
        { name: 'pz_csrf', value: '', options: { path: '/', maxAge: 0 } },
      ]),
      csrfCookieOptions: jest.fn(() => ({ httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: 1 })),
      csrfCookieName: 'pz_csrf',
    } as never;

    response = { cookie: jest.fn(), clearCookie: jest.fn() };

    controller = new AuthController(auth as unknown as AuthService, sessions as unknown as SessionService);
  });

  describe('login', () => {
    const body = { email: 'dana@example.com', password: 'correct-horse' } as LoginRequestDto;

    it('passes the origin through so the session records where it came from', async () => {
      await controller.login(body, undefined, request(), response);

      expect(auth.login).toHaveBeenCalledWith('dana@example.com', 'correct-horse', null, {
        userAgent: 'Mozilla/5.0',
        ip: '203.0.113.7',
      });
    });

    it('forwards the merchant chooser answer from the query string', async () => {
      await controller.login(body, 'mch_01HQ8ZZZ000000000000000B', request(), response);

      expect(auth.login).toHaveBeenCalledWith(
        'dana@example.com',
        'correct-horse',
        'mch_01HQ8ZZZ000000000000000B',
        expect.anything(),
      );
    });

    it('tolerates a request with no user agent', async () => {
      await controller.login(body, undefined, request({ headers: {} }), response);

      expect(auth.login).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
        { userAgent: null, ip: '203.0.113.7' },
      );
    });
  });

  describe('logout', () => {
    it('accepts a well-formed login', async () => {
      await expect(
        errorsFor({ email: 'dana@example.com', password: 'correct-horse' }),
      ).resolves.toEqual([]);
    });

    it('rejects a malformed address', async () => {
      await expect(errorsFor({ email: 'dana', password: 'correct-horse' })).resolves.toContain('email');
    });

    it('rejects a 4MB "password" — argon2 will hash whatever it is given', async () => {
      await expect(
        errorsFor({ email: 'dana@example.com', password: 'x'.repeat(4_000_000) }),
      ).resolves.toContain('password');
    });
  });
});
