import { PrincipalFactory } from 'src/auth/principal/principal.factory';
import { CsrfService } from 'src/auth/session/csrf.service';
import { SESSION_COOKIE, SessionService } from 'src/auth/session/session.service';
import { InMemorySessionStore } from 'src/auth/session/session.store';
import { AuthenticationRequiredException, PermissionDeniedException } from 'src/common/errors/auth.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { Clock } from 'src/common/time/clock';
import type { ApiConfig } from 'src/config/api-config.type';

/**
 * The ordering assertion at the bottom of this file is the reason it exists: CSRF is checked
 * BEFORE the TTL slides, so a request rejected for a bad CSRF token cannot keep a stolen
 * session alive by being made repeatedly.
 */
describe('SessionService', () => {
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const MERCHANT = 'mch_01HQ8ZZZ0000000000000001';
  const USER = 'usr_01HQ8ZZZ0000000000000009';

  const config = {
    runtime: { nodeEnv: 'production' },
    auth: { csrfCookieName: 'pz_csrf', csrfTtlSeconds: 86_400, sessionTtlSeconds: 43_200 },
  } as unknown as ApiConfig;

  let store: InMemorySessionStore;
  let sessions: SessionService;
  let clock: Clock;

  beforeEach(() => {
    store = new InMemorySessionStore();
    clock = { nowMs: () => NOW.getTime(), now: () => NOW } as Clock;

    sessions = new SessionService(
      store,
      new CsrfService(config),
      new PrincipalFactory(),
      clock,
      config,
      new NoopLogger(),
    );
  });

  const origin = { userAgent: 'Mozilla/5.0', ip: '203.0.113.7' };

  describe('issue', () => {
    it('stores a merchant_user record and returns both cookies', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      expect(issued.record.kind).toBe('merchant_user');
      expect(issued.sessionCookie.name).toBe(SESSION_COOKIE);
      expect(issued.csrfCookie.name).toBe('pz_csrf');
      await expect(store.get(issued.record.id)).resolves.not.toBeNull();
    });

    it('makes pz_session HttpOnly and pz_csrf readable', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      expect(issued.sessionCookie.options.httpOnly).toBe(true);
      expect(issued.csrfCookie.options.httpOnly).toBe(false);
    });

    it('mints an opaque id that is not derived from the user id', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      expect(issued.record.id).not.toContain(USER);
      expect(issued.record.id).toHaveLength(43);
    });

    it('truncates a hostile user agent', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', {
        userAgent: 'x'.repeat(5_000),
        ip: null,
      });

      expect(issued.record.userAgent).toHaveLength(200);
    });

    it('stamps the record from the injected clock', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      expect(issued.record.createdAtMs).toBe(NOW.getTime());
      expect(issued.record.lastSeenAtMs).toBe(NOW.getTime());
    });
  });

  describe('issueStaff', () => {
    it('carries no merchant at all', async () => {
      const issued = await sessions.issueStaff('stf_0001', 'finance', origin);

      expect(issued.record.kind).toBe('staff');
      expect(issued.record.merchantId).toBeNull();
      expect(issued.record.userId).toBeNull();
      expect(issued.record.staffRole).toBe('finance');
    });

    it('uses the same cookie name as a merchant session', async () => {
      const issued = await sessions.issueStaff('stf_0001', 'finance', origin);

      expect(issued.sessionCookie.name).toBe(SESSION_COOKIE);
    });
  });

  describe('resolve', () => {
    it('returns a dashboard_session principal', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'developer', origin);

      const principal = await sessions.resolve(issued.record.id, 'GET', undefined);

      expect(principal).toEqual({
        kind: 'dashboard_session',
        merchant_id: MERCHANT,
        user_id: USER,
        role: 'developer',
      });
    });

    it('requires the CSRF header on a mutating request', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      await expect(sessions.resolve(issued.record.id, 'POST', undefined)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
    });

    it('accepts a mutating request with the matching CSRF header', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      await expect(
        sessions.resolve(issued.record.id, 'POST', issued.record.csrfToken),
      ).resolves.toMatchObject({ kind: 'dashboard_session' });
    });

    it('throws when no cookie was presented', async () => {
      await expect(sessions.resolve(undefined, 'GET', undefined)).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });

    it('throws when the session is unknown or expired', async () => {
      await expect(sessions.resolve('sess_nope', 'GET', undefined)).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });

    it('does NOT slide the TTL when CSRF fails', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);
      const touch = jest.spyOn(store, 'touch');

      await sessions.resolve(issued.record.id, 'POST', 'wrong-token').catch(() => undefined);

      // The order in resolve() is: assert, then touch. A stolen cookie replayed with a bad
      // CSRF token must not keep itself alive.
      expect(touch).not.toHaveBeenCalled();
    });

    it('slides the TTL on a request that passes', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);
      const touch = jest.spyOn(store, 'touch');

      await sessions.resolve(issued.record.id, 'GET', undefined);

      expect(touch).toHaveBeenCalledWith(issued.record.id, 43_200);
    });
  });

  describe('resolveStaff', () => {
    it('returns null for a merchant session — StaffGuard then refuses', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'admin', origin);

      await expect(sessions.resolveStaff(issued.record.id, 'GET', undefined, null)).resolves.toBeNull();
    });

    it('takes the acting merchant from the argument, never from the record', async () => {
      const issued = await sessions.issueStaff('stf_0001', 'risk', origin);

      const principal = await sessions.resolveStaff(issued.record.id, 'GET', undefined, MERCHANT);

      expect(principal).toEqual({
        kind: 'staff_session',
        staff_id: 'stf_0001',
        role: 'risk',
        acting_merchant_id: MERCHANT,
      });
    });

    it('lets one session act on a different merchant per request', async () => {
      const issued = await sessions.issueStaff('stf_0001', 'support', origin);

      const first = await sessions.resolveStaff(issued.record.id, 'GET', undefined, MERCHANT);
      const second = await sessions.resolveStaff(issued.record.id, 'GET', undefined, 'mch_other');

      expect(first).toMatchObject({ acting_merchant_id: MERCHANT });
      expect(second).toMatchObject({ acting_merchant_id: 'mch_other' });
    });
  });

  describe('resolveForUpgrade', () => {
    it('demands CSRF even though a WebSocket handshake has no method', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'viewer', origin);

      await expect(sessions.resolveForUpgrade(issued.record.id, undefined)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
      await expect(
        sessions.resolveForUpgrade(issued.record.id, issued.record.csrfToken),
      ).resolves.toMatchObject({ kind: 'dashboard_session' });
    });
  });

  describe('refreshCsrf', () => {
    it('returns the stored token and slides the TTL', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'owner', origin);
      const touch = jest.spyOn(store, 'touch');

      await expect(sessions.refreshCsrf(issued.record.id)).resolves.toBe(issued.record.csrfToken);
      expect(touch).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('removes the record', async () => {
      const issued = await sessions.issue(USER, MERCHANT, 'owner', origin);

      await sessions.destroy(issued.record.id);

      await expect(store.get(issued.record.id)).resolves.toBeNull();
    });

    it('is a no-op with no cookie — logout without a session is still a 204', async () => {
      await expect(sessions.destroy(undefined)).resolves.toBeUndefined();
    });
  });

  describe('destroyAllForUser', () => {
    it('drops every live session for that user', async () => {
      await sessions.issue(USER, MERCHANT, 'owner', origin);
      await sessions.issue(USER, MERCHANT, 'owner', origin);

      await expect(sessions.destroyAllForUser(USER)).resolves.toBe(2);
    });
  });

  describe('expiredCookies', () => {
    it('clears both cookies on the same path they were set on', () => {
      const cleared = sessions.expiredCookies();

      expect(cleared.map((c) => c.name)).toEqual([SESSION_COOKIE, 'pz_csrf']);
      for (const cookie of cleared) {
        expect(cookie.options).toEqual({ path: '/', maxAge: 0 });
        expect(cookie.value).toBe('');
      }
    });
  });

  it('exposes the CSRF cookie name and options for the controller', () => {
    expect(sessions.csrfCookieName).toBe('pz_csrf');
    expect(sessions.csrfCookieOptions().httpOnly).toBe(false);
  });
});
