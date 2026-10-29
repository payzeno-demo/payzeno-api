import type { CookieResponse } from 'src/auth/auth.controller';
import type { AuthService } from 'src/auth/auth.service';
import type { AuthenticatedRequest } from 'src/auth/guards/base-auth.guard';
import { STAFF_SESSION_COOKIE, type SessionService } from 'src/auth/session/session.service';
import { StaffAuthController, type StaffLoginRequestDto } from 'src/auth/staff-auth.controller';
import { AuthenticationRequiredException } from 'src/common/errors/auth.exceptions';

/**
 * RFC platform-v2 §1. The admin app's session is `pz_staff_session`, never the console's
 * `pz_session`, with the same readable `pz_csrf` beside it — so the admin app's ApiClient needs
 * nothing the console's does not already do.
 */
describe('StaffAuthController', () => {
  const staffBody = { object: 'staff_session', staff: { id: 'stf_1', role: 'risk' } };
  const issued = {
    record: { id: 'sess_staff' },
    sessionCookie: { name: STAFF_SESSION_COOKIE, value: 'sess_staff', options: { httpOnly: true, path: '/' } },
    csrfCookie: { name: 'pz_csrf', value: 'csrf-token', options: { httpOnly: false, path: '/' } },
  };

  let auth: { loginStaff: jest.Mock; logout: jest.Mock; describeStaffSession: jest.Mock };
  let sessions: { expiredCookies: jest.Mock; csrfCookieOptions: jest.Mock; csrfCookieName: string };
  let response: jest.Mocked<CookieResponse>;
  let controller: StaffAuthController;

  function request(cookies: Record<string, string> = {}): AuthenticatedRequest {
    return {
      method: 'POST',
      url: '/v1/staff/auth/login',
      ip: '198.51.100.4',
      headers: { 'user-agent': 'admin-bot/1' },
      cookies,
      params: {},
      query: {},
    } as AuthenticatedRequest;
  }

  beforeEach(() => {
    auth = {
      loginStaff: jest.fn(async () => ({ issued, body: staffBody })),
      logout: jest.fn(async () => undefined),
      describeStaffSession: jest.fn(async () => ({ body: staffBody, csrfToken: 'fresh-csrf' })),
    };
    sessions = {
      expiredCookies: jest.fn((name: string) => [
        { name, value: '', options: { path: '/', maxAge: 0 } },
        { name: 'pz_csrf', value: '', options: { path: '/', maxAge: 0 } },
      ]),
      csrfCookieOptions: jest.fn(() => ({ httpOnly: false, path: '/' })),
      csrfCookieName: 'pz_csrf',
    };
    response = { cookie: jest.fn(), clearCookie: jest.fn() };
    controller = new StaffAuthController(auth as unknown as AuthService, sessions as unknown as SessionService);
  });

  it('logs in with pz_staff_session + pz_csrf and answers StaffSessionResponse', async () => {
    const body = { email: 'risk@payzeno.example', password: 'Payzeno-risk-demo-1' } as StaffLoginRequestDto;

    const out = await controller.login(body, request(), response);

    expect(auth.loginStaff).toHaveBeenCalledWith('risk@payzeno.example', 'Payzeno-risk-demo-1', {
      userAgent: 'admin-bot/1',
      ip: '198.51.100.4',
    });
    expect(response.cookie).toHaveBeenCalledWith(STAFF_SESSION_COOKIE, 'sess_staff', expect.objectContaining({ httpOnly: true }));
    expect(response.cookie).toHaveBeenCalledWith('pz_csrf', 'csrf-token', expect.objectContaining({ httpOnly: false }));
    expect(response.cookie).not.toHaveBeenCalledWith('pz_session', expect.anything(), expect.anything());
    expect(out).toBe(staffBody);
  });

  it('logs out the staff session and clears its cookie, not the console one', async () => {
    await controller.logout(request({ [STAFF_SESSION_COOKIE]: 'sess_staff', pz_session: 'sess_merchant' }), response);

    expect(auth.logout).toHaveBeenCalledWith('sess_staff');
    expect(sessions.expiredCookies).toHaveBeenCalledWith(STAFF_SESSION_COOKIE);
    expect(response.clearCookie).toHaveBeenCalledWith(STAFF_SESSION_COOKIE, { path: '/', maxAge: 0 });
  });

  it('describes the session and refreshes pz_csrf on /me', async () => {
    const out = await controller.me(request({ [STAFF_SESSION_COOKIE]: 'sess_staff' }), response);

    expect(auth.describeStaffSession).toHaveBeenCalledWith('sess_staff');
    expect(response.cookie).toHaveBeenCalledWith('pz_csrf', 'fresh-csrf', { httpOnly: false, path: '/' });
    expect(out).toBe(staffBody);
  });

  it('401s /me without the staff cookie', async () => {
    await expect(controller.me(request({ pz_session: 'sess_merchant' }), response)).rejects.toBeInstanceOf(
      AuthenticationRequiredException,
    );
  });
});
