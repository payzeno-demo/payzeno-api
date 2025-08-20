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
  it('collapses a repeated CSRF header to its first value', async () => {
    const { context } = guardContext({
      method: 'PATCH',
      cookies: { [SESSION_COOKIE]: 'sess_abcdef' },
      headers: { [CSRF_HEADER]: ['first-token', 'second-token'] },
    });

    await guard.canActivate(context);

    expect(sessions.resolve).toHaveBeenCalledWith('sess_abcdef', 'PATCH', 'first-token');
  });

});
