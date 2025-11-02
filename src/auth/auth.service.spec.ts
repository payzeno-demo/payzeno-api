import * as argon2 from 'argon2';

import { AuthService } from 'src/auth/auth.service';
import type { SessionService } from 'src/auth/session/session.service';
import { ConflictException } from 'src/common/errors/api.exception';
import { AuthenticationRequiredException } from 'src/common/errors/auth.exceptions';
import { MerchantNotFoundException } from 'src/common/errors/not-found.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { Clock } from 'src/common/time/clock';
import type { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import type { MerchantUserEntity } from 'src/merchants/users/merchant-user.entity';
import type { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';
import type { StaffUsersService } from 'src/staff/staff-users.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  verify: jest.fn(async (stored: string, presented: string) => stored === `hash:${presented}`),
}));

/**
 * The merchant chooser is the interesting half of this file.
 *
 * `merchant_user.email` is unique PER MERCHANT, so `(email, password)` resolves to a SET.
 * Accountants and agencies routinely hold a login at two merchants. Picking the first one
 * would silently log somebody into the wrong tenant, so the service raises `409 conflict`
 * listing the choices and the console re-submits with `?merchant_id=`.
 *
 * The other half is timing. Every failure path spends one argon2 verify — against a real hash
 * when we have one, against a dummy when we do not — because a login that returns in 3ms for
 * an unknown address and 90ms for a known one enumerates the customer base regardless of what
 * the body says.
 */
describe('AuthService', () => {
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const MERCHANT_A = 'mch_01HQ8ZZZ000000000000000A';
  const MERCHANT_B = 'mch_01HQ8ZZZ000000000000000B';

  let users: jest.Mocked<Pick<MerchantUserRepository, 'findLoginCandidates' | 'findByIdForMerchant' | 'touchLastLogin'>>;
  let merchants: jest.Mocked<Pick<MerchantRepository, 'findById'>>;
  let sessions: jest.Mocked<
    Pick<SessionService, 'issue' | 'issueStaff' | 'requireRecord' | 'refreshCsrf' | 'destroy' | 'destroyAllForUser'>
  >;
  let staff: jest.Mocked<Pick<StaffUsersService, 'authenticate'>>;
  let service: AuthService;

  function user(overrides: Partial<MerchantUserEntity> = {}): MerchantUserEntity {
    const row = {
      id: 'usr_0001',
      merchantId: MERCHANT_A,
      email: 'dana@example.com',
      role: 'admin',
      passwordHash: 'hash:correct-horse',
      canLogIn: () => true,
      toUser: () => ({ id: 'usr_0001', object: 'user', email: 'dana@example.com', role: 'admin' }),
      ...overrides,
    };
    return row as unknown as MerchantUserEntity;
  }

  function merchant(id = MERCHANT_A): MerchantEntity {
    return {
      id,
      legalName: 'Northwind Trading Ltd',
      displayName: 'Northwind',
      status: 'active',
      country: 'GB',
      defaultCurrency: 'GBP',
      mcc: '5734',
      statementDescriptor: 'NORTHWIND',
      captureAtSettlement: false,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as MerchantEntity;
  }

  const origin = { userAgent: 'Mozilla/5.0', ip: '203.0.113.7' };

  beforeEach(() => {
    jest.clearAllMocks();

    users = {
      findLoginCandidates: jest.fn(async () => []),
      findByIdForMerchant: jest.fn(async () => null),
      touchLastLogin: jest.fn(async () => undefined),
    } as never;

    merchants = { findById: jest.fn(async () => merchant()) } as never;

    sessions = {
      issue: jest.fn(async () => ({ record: { id: 'sess_1', csrfToken: 'csrf' } })),
      issueStaff: jest.fn(async () => ({ record: { id: 'sess_staff', csrfToken: 'csrf' } })),
      requireRecord: jest.fn(),
      refreshCsrf: jest.fn(async () => 'fresh-csrf'),
      destroy: jest.fn(async () => undefined),
      destroyAllForUser: jest.fn(async () => 1),
    } as never;

    staff = { authenticate: jest.fn(async () => null) } as never;

    const clock = { nowMs: () => NOW.getTime(), now: () => NOW } as Clock;

    service = new AuthService(
      users as unknown as MerchantUserRepository,
      merchants as unknown as MerchantRepository,
      sessions as unknown as SessionService,
      staff as unknown as StaffUsersService,
      clock,
      new NoopLogger(),
    );
  });

  describe('login', () => {
    it('issues a session for the single matching login', async () => {
      users.findLoginCandidates.mockResolvedValue([user()]);

      const outcome = await service.login('dana@example.com', 'correct-horse', null, origin);

      expect(sessions.issue).toHaveBeenCalledWith('usr_0001', MERCHANT_A, 'admin', origin);
      expect(outcome.body.object).toBe('login');
      expect(outcome.body.merchant.id).toBe(MERCHANT_A);
    });

    it('lowercases and trims the address before the lookup', async () => {
      users.findLoginCandidates.mockResolvedValue([user()]);

      await service.login('  Dana@Example.com ', 'correct-horse', null, origin);

      expect(users.findLoginCandidates).toHaveBeenCalledWith('dana@example.com');
    });

    it('records the login timestamp', async () => {
      users.findLoginCandidates.mockResolvedValue([user()]);

      await service.login('dana@example.com', 'correct-horse', null, origin);

      expect(users.touchLastLogin).toHaveBeenCalledWith('usr_0001', NOW);
    });

    it('rejects an unknown address', async () => {
      users.findLoginCandidates.mockResolvedValue([]);

      await expect(service.login('nobody@example.com', 'x', null, origin)).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });

    it('spends an argon2 verify even when nothing matched', async () => {
      users.findLoginCandidates.mockResolvedValue([]);

      await service.login('nobody@example.com', 'x', null, origin).catch(() => undefined);

      // Against the dummy hash. Without this the response time answers "does this address
      // have an account?" for anybody who cares to measure it.
      expect(argon2.verify).toHaveBeenCalledTimes(1);
    });

    it('rejects a wrong password with the same exception as an unknown address', async () => {
      users.findLoginCandidates.mockResolvedValue([user()]);

      await expect(
        service.login('dana@example.com', 'wrong', null, origin),
      ).rejects.toBeInstanceOf(AuthenticationRequiredException);
    });

    it('ignores a candidate whose account cannot log in', async () => {
      users.findLoginCandidates.mockResolvedValue([user({ canLogIn: () => false } as never)]);

      await expect(
        service.login('dana@example.com', 'correct-horse', null, origin),
      ).rejects.toBeInstanceOf(AuthenticationRequiredException);
    });

    describe('the merchant chooser', () => {
      const both = () => [
        user({ id: 'usr_a', merchantId: MERCHANT_A }),
        user({ id: 'usr_b', merchantId: MERCHANT_B }),
      ];

      it('raises 409 conflict when the address has a login at two merchants', async () => {
        users.findLoginCandidates.mockResolvedValue(both());

        await expect(
          service.login('dana@example.com', 'correct-horse', null, origin),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('lists the merchant ids so the console can render the chooser', async () => {
        users.findLoginCandidates.mockResolvedValue(both());

        const err = await service
          .login('dana@example.com', 'correct-horse', null, origin)
          .catch((e: ConflictException) => e);

        expect((err as ConflictException).details).toMatchObject({
          reason: 'merchant_chooser_required',
          merchant_ids: `${MERCHANT_A},${MERCHANT_B}`,
        });
      });

      it('logs in directly when the caller named one of them', async () => {
        users.findLoginCandidates.mockResolvedValue(both());

        await service.login('dana@example.com', 'correct-horse', MERCHANT_B, origin);

        expect(sessions.issue).toHaveBeenCalledWith('usr_b', MERCHANT_B, 'admin', origin);
      });

      it('rejects a merchant the address has no login at — 401, not 404', async () => {
        users.findLoginCandidates.mockResolvedValue([user()]);

        // The address authenticated; it just has no login there. A 404 would confirm the
        // merchant exists to anybody with any valid Payzeno login.
        await expect(
          service.login('dana@example.com', 'correct-horse', 'mch_someone_else', origin),
        ).rejects.toBeInstanceOf(AuthenticationRequiredException);
      });
    });

    it('raises MerchantNotFoundException when the tenant row has gone', async () => {
      users.findLoginCandidates.mockResolvedValue([user()]);
      merchants.findById.mockResolvedValue(null);

      await expect(
        service.login('dana@example.com', 'correct-horse', null, origin),
      ).rejects.toBeInstanceOf(MerchantNotFoundException);
    });
  });

  describe('loginStaff', () => {
    it('delegates the credential check to StaffUsersService', async () => {
      staff.authenticate.mockResolvedValue({ id: 'stf_0001', role: 'risk' } as never);

      await service.loginStaff('ops@payzeno.com', 'hunter2', origin);

      expect(staff.authenticate).toHaveBeenCalledWith('ops@payzeno.com', 'hunter2');
      expect(sessions.issueStaff).toHaveBeenCalledWith('stf_0001', 'risk', origin);
    });

    it('rejects when the operator does not authenticate', async () => {
      staff.authenticate.mockResolvedValue(null);

      await expect(service.loginStaff('ops@payzeno.com', 'nope', origin)).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });

    it('never issues a merchant session for an operator', async () => {
      staff.authenticate.mockResolvedValue({ id: 'stf_0001', role: 'support' } as never);

      await service.loginStaff('ops@payzeno.com', 'hunter2', origin);

      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  describe('describeSession', () => {
    const record = {
      id: 'sess_1',
      kind: 'merchant_user',
      userId: 'usr_0001',
      merchantId: MERCHANT_A,
    };

    it('returns the user, the merchant and the role permissions', async () => {
      sessions.requireRecord.mockResolvedValue(record as never);
      users.findByIdForMerchant.mockResolvedValue(user());

      const described = await service.describeSession('sess_1');

      expect(described.body.object).toBe('session');
      expect(described.body.permissions).toContain('payouts:write');
      expect(described.csrfToken).toBe('fresh-csrf');
    });

    it('gives a viewer no permissions at all', async () => {
      sessions.requireRecord.mockResolvedValue(record as never);
      users.findByIdForMerchant.mockResolvedValue(user({ role: 'viewer' } as never));

      const described = await service.describeSession('sess_1');

      expect(described.body.permissions).toEqual([]);
    });

    it('refuses a staff session — /v1/auth/me is the merchant console call', async () => {
      sessions.requireRecord.mockResolvedValue({ id: 'sess_1', kind: 'staff' } as never);

      await expect(service.describeSession('sess_1')).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });

    it('refuses when the subject row has been deleted under a live session', async () => {
      sessions.requireRecord.mockResolvedValue(record as never);
      users.findByIdForMerchant.mockResolvedValue(null);

      await expect(service.describeSession('sess_1')).rejects.toBeInstanceOf(
        AuthenticationRequiredException,
      );
    });
  });

  describe('requestPasswordReset', () => {
    it('revokes every live session for the address', async () => {
      users.findLoginCandidates.mockResolvedValue([
        user({ id: 'usr_a', merchantId: MERCHANT_A }),
        user({ id: 'usr_b', merchantId: MERCHANT_B }),
      ]);

      await service.requestPasswordReset('dana@example.com');

      // A reset that does not invalidate the attacker's session resets nothing.
      expect(sessions.destroyAllForUser).toHaveBeenCalledWith('usr_a');
      expect(sessions.destroyAllForUser).toHaveBeenCalledWith('usr_b');
    });

    it('resolves quietly for an unknown address — the route is always 202', async () => {
      users.findLoginCandidates.mockResolvedValue([]);

      await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
      expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('destroys the session', async () => {
      await service.logout('sess_1');

      expect(sessions.destroy).toHaveBeenCalledWith('sess_1');
    });

    it('tolerates a request with no cookie', async () => {
      await expect(service.logout(undefined)).resolves.toBeUndefined();
    });
  });
});
