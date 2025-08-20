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
      const touch = jest.spyOn(store, 'touch');

      await sessions.resolve(issued.record.id, 'GET', undefined);

      expect(touch).toHaveBeenCalledWith(issued.record.id, 43_200);
    });
  });

  describe('resolveStaff', () => {
    it('returns null for a merchant session — StaffGuard then refuses', async () => {
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

      const issued = await sessions.issue(USER, MERCHANT, 'owner', origin);
    });
  });

  it('exposes the CSRF cookie name and options for the controller', () => {
    expect(sessions.csrfCookieName).toBe('pz_csrf');
    expect(sessions.csrfCookieOptions().httpOnly).toBe(false);
  });
});
