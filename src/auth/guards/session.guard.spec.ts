import { SessionGuard } from 'src/auth/guards/session.guard';
import { CSRF_HEADER } from 'src/auth/session/csrf.service';
import { SESSION_COOKIE, SessionService } from 'src/auth/session/session.service';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';

import { makeSessionPrincipal } from 'test/factories/principal.factory';
import { guardContext, rejectsWith } from 'test/support/guard-context';

/**
 * The console's cookie session. The guard itself is thin on purpose — CSRF and TTL sliding
 * both live in `SessionService.resolve`, because a check split across a guard and a service
 * is a check one of the two eventually stops doing.
 *
 * What this spec pins is the wiring: the cookie name, the header name, and that the request
 * METHOD reaches the service. `resolve` exempts safe methods from CSRF, so a guard that
 * forgot to forward `request.method` would exempt every request including the mutating ones.
 */
describe('SessionGuard', () => {
  let sessions: { resolve: jest.Mock };
  let guard: SessionGuard;

  it('resolves the pz_session cookie and attaches a dashboard_session principal', async () => {
    const { context, request } = guardContext({
      method: 'GET',
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(sessions.resolve).toHaveBeenCalledWith('sess_abcdef', 'GET', undefined);
    expect(request.principal).toEqual(principal);
  });

  it('forwards the request method so the service can decide CSRF applies', async () => {
    const { context } = guardContext({
      method: 'POST',
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
      headers: { [CSRF_HEADER]: 'csrf-token-value' },
    });

    await guard.canActivate(context);

    expect(sessions.resolve).toHaveBeenCalledWith('sess_abcdef', 'POST', 'csrf-token-value');
  });

  it('collapses a repeated CSRF header to its first value', async () => {
    const { context } = guardContext({
      method: 'PATCH',
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
      headers: { [CSRF_HEADER]: ['first-token', 'second-token'] },
    });

    await guard.canActivate(context);

    expect(sessions.resolve).toHaveBeenCalledWith('sess_abcdef', 'PATCH', 'first-token');
  });

  it('declines the request when there is no session cookie, so ApiKeyGuard can win instead', async () => {
    const { context } = guardContext({ headers: { authorization: 'Bearer sk_live_x' } });

    await rejectsWith(guard.canActivate(context), AuthenticationRequiredException);
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('propagates the 403 the CSRF check raises without turning it into a 401', async () => {
    sessions.resolve.mockRejectedValue(
      new PermissionDeniedException('Missing X-Payzeno-CSRF header', {
        reason: 'csrf_header_absent',
      }),
    );

    const { context } = guardContext({
      method: 'DELETE',
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
    });

    const err = await rejectsWith(guard.canActivate(context), PermissionDeniedException);
    expect(err.httpStatus).toBe(403);
  });

  it('leaves an already-attached principal alone', async () => {
    const existing = makeSessionPrincipal({ role: 'viewer' });
    const { context, request } = guardContext({
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
      principal: existing,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(sessions.resolve).not.toHaveBeenCalled();
    expect(request.principal).toEqual(existing);
  });
});
