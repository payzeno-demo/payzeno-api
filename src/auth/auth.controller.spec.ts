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

    it('sets both cookies', async () => {
      await controller.login(body, undefined, request(), response);

      expect(response.cookie).toHaveBeenCalledTimes(2);
      expect(response.cookie).toHaveBeenCalledWith(SESSION_COOKIE, 'sess_1', expect.anything());
      expect(response.cookie).toHaveBeenCalledWith('pz_csrf', 'csrf-token', expect.anything());
    });

    it('sets pz_session HttpOnly and pz_csrf readable', async () => {
      await controller.login(body, undefined, request(), response);

      const [, , sessionOptions] = response.cookie.mock.calls[0];
      const [, , csrfOptions] = response.cookie.mock.calls[1];

      expect(sessionOptions).toMatchObject({ httpOnly: true });
      expect(csrfOptions).toMatchObject({ httpOnly: false });
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
    it('destroys the session named by the cookie', async () => {
      await controller.logout(request({ cookies: { [SESSION_COOKIE]: 'sess_1' } }), response);

      expect(auth.logout).toHaveBeenCalledWith('sess_1');
    });

    it('clears both cookies', async () => {
      await controller.logout(request({ cookies: {} }), response);

      expect(response.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/', maxAge: 0 });
      expect(response.clearCookie).toHaveBeenCalledWith('pz_csrf', { path: '/', maxAge: 0 });
    });
  });

  describe('me', () => {
    it('returns the session description and refreshes pz_csrf', async () => {
      const result = await controller.me(
        request({ method: 'GET', cookies: { [SESSION_COOKIE]: 'sess_1' } }),
        response,
      );

      expect(result).toEqual({ object: 'session' });
      expect(response.cookie).toHaveBeenCalledWith('pz_csrf', 'fresh-csrf', expect.anything());
    });

    it('throws when the cookie is missing even though the guard let it through', async () => {
      // Belt and braces: SessionGuard should have rejected this, and if it did not, /me is
      // not the place to find out by dereferencing undefined.
      await expect(controller.me(request({ method: 'GET', cookies: {} }), response)).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });
  });

  describe('password reset', () => {
    it('delegates and returns nothing — the route is a bare 202', async () => {
      await expect(
        controller.requestPasswordReset({ email: 'dana@example.com' } as PasswordResetRequestDto),
      ).resolves.toBeUndefined();

      expect(auth.requestPasswordReset).toHaveBeenCalledWith('dana@example.com');
    });
  });

  describe('LoginRequestDto', () => {
    async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
      const dto = plainToInstance(LoginRequestDto, payload);
      const errors = await validate(dto);
      return errors.map((e) => e.property);
    }

    it('accepts a well-formed login', async () => {
      await expect(
        errorsFor({ email: 'dana@example.com', password: 'correct-horse' }),
      ).resolves.toEqual([]);
    });

    it('rejects a malformed address', async () => {
      await expect(errorsFor({ email: 'dana', password: 'correct-horse' })).resolves.toContain('email');
    });

    it('rejects a password under 8 characters', async () => {
      await expect(errorsFor({ email: 'dana@example.com', password: 'short' })).resolves.toContain(
        'password',
      );
    });

    it('rejects a 4MB "password" — argon2 will hash whatever it is given', async () => {
      await expect(
        errorsFor({ email: 'dana@example.com', password: 'x'.repeat(4_000_000) }),
      ).resolves.toContain('password');
    });
  });
});
