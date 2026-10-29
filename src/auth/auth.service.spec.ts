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
import type { MerchantUserTokensService } from 'src/merchants/users/user-tokens.service';
import { InvalidLinkTokenException } from 'src/common/errors/identity.exceptions';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { ApiConfig } from 'src/config/api-config.type';
import type { EmailService } from 'src/notifications/email/email.service';
import type { StaffUsersService } from 'src/staff/staff-users.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  verify: jest.fn(async (stored: string, presented: string) => stored === `hash:${presented}`),
  hash: jest.fn(async (plain: string) => `hash:${plain}`),
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

  let users: jest.Mocked<
    Pick<
      MerchantUserRepository,
      'findLoginCandidates' | 'findByIdForMerchant' | 'touchLastLogin' | 'activateInvited' | 'replacePassword'
    >
  >;
  let merchants: jest.Mocked<Pick<MerchantRepository, 'findById'>>;
  let sessions: jest.Mocked<
    Pick<SessionService, 'issue' | 'issueStaff' | 'requireRecord' | 'refreshCsrf' | 'destroy' | 'destroyAllForUser'>
  >;
  let staff: jest.Mocked<Pick<StaffUsersService, 'authenticate' | 'resolveActive'>>;
  let tokens: jest.Mocked<Pick<MerchantUserTokensService, 'issue' | 'consume'>>;
  let email: jest.Mocked<Pick<EmailService, 'queue'>>;
  const manager = { tx: true };
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
      toIsoCreatedAt: () => NOW.toISOString(),
      toIsoUpdatedAt: () => NOW.toISOString(),
    } as unknown as MerchantEntity;
  }

  const origin = { userAgent: 'Mozilla/5.0', ip: '203.0.113.7' };

  beforeEach(() => {
    jest.clearAllMocks();

    users = {
      findLoginCandidates: jest.fn(async () => []),
      findByIdForMerchant: jest.fn(async () => null),
      touchLastLogin: jest.fn(async () => undefined),
      activateInvited: jest.fn(async () => 1),
      replacePassword: jest.fn(async () => 1),
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

    staff = { authenticate: jest.fn(async () => null), resolveActive: jest.fn() } as never;
    tokens = {
      issue: jest.fn(async () => 'raw-token/with+chars'),
      consume: jest.fn(async () => ({ id: 'tok_1', userId: 'usr_0001', merchantId: MERCHANT_A })),
    } as never;
    email = { queue: jest.fn(async () => undefined) } as never;

    const clock = { nowMs: () => NOW.getTime(), now: () => NOW } as Clock;
    const transactions = {
      runInTransaction: jest.fn((fn: (m: unknown) => Promise<unknown>) => fn(manager)),
    } as unknown as TransactionManager;
    const config = { publicUrls: { console: 'http://console.test', admin: null } } as unknown as ApiConfig;

    service = new AuthService(
      users as unknown as MerchantUserRepository,
      merchants as unknown as MerchantRepository,
      sessions as unknown as SessionService,
      staff as unknown as StaffUsersService,
      clock,
      new NoopLogger(),
      transactions,
      tokens as unknown as MerchantUserTokensService,
      email as unknown as EmailService,
      config,
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
    const operator = {
      id: 'stf_0001',
      role: 'risk',
      toStaffUser: () => ({ id: 'stf_0001', object: 'staff_user', email: 'ops@payzeno.com', full_name: 'Ops', role: 'risk' }),
    };

    it('answers with the operator, never the hash', async () => {
      staff.authenticate.mockResolvedValue(operator as never);

      const outcome = await service.loginStaff('Ops@Payzeno.com ', 'hunter2', origin);

      expect(staff.authenticate).toHaveBeenCalledWith('ops@payzeno.com', 'hunter2');
      expect(outcome.body).toEqual({ object: 'staff_session', staff: operator.toStaffUser() });
    });

    it('delegates the credential check to StaffUsersService', async () => {
      staff.authenticate.mockResolvedValue(operator as never);

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
      staff.authenticate.mockResolvedValue(operator as never);

      await service.loginStaff('ops@payzeno.com', 'hunter2', origin);

      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  describe('describeStaffSession', () => {
    it('re-reads the operator row and refreshes pz_csrf', async () => {
      sessions.requireRecord.mockResolvedValue({ id: 'sess_staff', kind: 'staff', staffId: 'stf_0001' } as never);
      staff.resolveActive.mockResolvedValue({
        toStaffUser: () => ({ id: 'stf_0001', object: 'staff_user', email: 'a@b', full_name: 'A', role: 'admin' }),
      } as never);

      const described = await service.describeStaffSession('sess_staff');

      expect(staff.resolveActive).toHaveBeenCalledWith('stf_0001');
      expect(described.body).toMatchObject({ object: 'staff_session', staff: { role: 'admin' } });
      expect(described.csrfToken).toBe('fresh-csrf');
    });

    it('refuses a merchant session presented as a staff one', async () => {
      sessions.requireRecord.mockResolvedValue({ id: 'sess_1', kind: 'merchant_user', userId: 'usr_1' } as never);

      await expect(service.describeStaffSession('sess_1')).rejects.toBeInstanceOf(AuthenticationRequiredException);
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

    it('gives a viewer read permissions and nothing that writes', async () => {
      sessions.requireRecord.mockResolvedValue(record as never);
      users.findByIdForMerchant.mockResolvedValue(user({ role: 'viewer' } as never));

      const described = await service.describeSession('sess_1');

      // The console filters its navigation by these strings; an empty list would hide it.
      expect(described.body.permissions).toContain('payments:read');
      expect(described.body.permissions.some((p) => p.endsWith(':write'))).toBe(false);
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
    it('emails one single-use link per login on the address, each naming its merchant', async () => {
      users.findLoginCandidates.mockResolvedValue([
        user({ id: 'usr_a', merchantId: MERCHANT_A }),
        user({ id: 'usr_b', merchantId: MERCHANT_B }),
      ]);

      await service.requestPasswordReset('  Dana@Example.com ');

      expect(users.findLoginCandidates).toHaveBeenCalledWith('dana@example.com');
      expect(tokens.issue).toHaveBeenCalledTimes(2);
      expect(tokens.issue).toHaveBeenCalledWith(expect.objectContaining({ id: 'usr_a' }), 'password_reset', manager);
      expect(email.queue).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'password_reset',
          to: 'dana@example.com',
          merchantId: MERCHANT_A,
          data: {
            reset_url: 'http://console.test/reset-password?token=raw-token%2Fwith%2Bchars',
            merchant_name: 'Northwind',
          },
        }),
        manager,
      );
    });

    it('does NOT revoke sessions — anyone can request a reset for anyone', async () => {
      users.findLoginCandidates.mockResolvedValue([user({ id: 'usr_a' })]);

      await service.requestPasswordReset('dana@example.com');

      expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
    });

    it('resolves quietly for an unknown address — the route is always 202', async () => {
      users.findLoginCandidates.mockResolvedValue([]);

      await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(email.queue).not.toHaveBeenCalled();
    });
  });

  describe('confirmPasswordReset', () => {
    it('spends the token, replaces the hash, then revokes every session of that login', async () => {
      await service.confirmPasswordReset('raw', 'a-new-long-password');

      expect(tokens.consume).toHaveBeenCalledWith('raw', 'password_reset', manager);
      expect(users.replacePassword).toHaveBeenCalledWith(MERCHANT_A, 'usr_0001', 'hash:a-new-long-password', manager);
      // A reset that does not invalidate the attacker's session resets nothing.
      expect(sessions.destroyAllForUser).toHaveBeenCalledWith('usr_0001');
    });

    it('refuses when the login is no longer active, and keeps the sessions', async () => {
      users.replacePassword.mockResolvedValue(0);

      await expect(service.confirmPasswordReset('raw', 'a-new-long-password')).rejects.toBeInstanceOf(
        InvalidLinkTokenException,
      );
      expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
    });

    it('lets a bad link through as the token service raised it', async () => {
      tokens.consume.mockRejectedValue(new InvalidLinkTokenException('token_expired'));

      await expect(service.confirmPasswordReset('raw', 'a-new-long-password')).rejects.toMatchObject({
        reason: 'token_expired',
      });
      expect(users.replacePassword).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('activates the invited owner and signs them in', async () => {
      users.findByIdForMerchant.mockResolvedValue(user({ role: 'owner' } as never));

      const outcome = await service.verifyEmail('raw', origin);

      expect(tokens.consume).toHaveBeenCalledWith('raw', 'email_verification', manager);
      expect(users.activateInvited).toHaveBeenCalledWith(MERCHANT_A, 'usr_0001', {}, manager);
      expect(sessions.issue).toHaveBeenCalledWith('usr_0001', MERCHANT_A, 'owner', origin);
      expect(outcome.body.object).toBe('login');
    });

    it('refuses a link for a login that is no longer invited', async () => {
      users.activateInvited.mockResolvedValue(0);

      await expect(service.verifyEmail('raw', origin)).rejects.toBeInstanceOf(InvalidLinkTokenException);
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvitation', () => {
    it('sets the chosen name and password, activates the login and signs in', async () => {
      users.findByIdForMerchant.mockResolvedValue(user());

      await service.acceptInvitation('raw', '  Dana Ops  ', 'correct-horse-battery', origin);

      expect(tokens.consume).toHaveBeenCalledWith('raw', 'invitation', manager);
      expect(users.activateInvited).toHaveBeenCalledWith(
        MERCHANT_A,
        'usr_0001',
        { passwordHash: 'hash:correct-horse-battery', fullName: 'Dana Ops' },
        manager,
      );
      expect(sessions.issue).toHaveBeenCalled();
    });

    it('does not sign in a login that was removed after the invitation went out', async () => {
      users.findByIdForMerchant.mockResolvedValue(user({ canLogIn: () => false } as never));

      await expect(
        service.acceptInvitation('raw', 'Dana', 'correct-horse-battery', origin),
      ).rejects.toBeInstanceOf(AuthenticationRequiredException);
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
