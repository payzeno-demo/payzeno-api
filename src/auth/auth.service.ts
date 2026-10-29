/**
 * AuthService — password verification, the merchant chooser, and session issue.
 *
 * The chooser is the part that surprises people. `merchant_user.email` is unique PER MERCHANT
 * (`uq_merchant_user_merchant_email`), so `(email, password)` resolves to a SET: accountants,
 * agencies and marketplace operators routinely hold a login at two merchants, and a global
 * unique index would also leak tenant existence at signup. When the set has more than one
 * member the caller has to say which merchant it means — `POST /v1/auth/login?merchant_id=…`
 * — and until it does we return `409 conflict` listing the choices. The request BODY is
 * `LoginRequest` from @payzeno/contracts and stays exactly that; the disambiguator is a query
 * parameter precisely so the frozen type does not have to grow a field.
 *
 * Timing: every failure path runs one argon2 verify, against a real hash when we have one and
 * against a dummy when we do not. A login that returns in 3ms for an unknown address and 90ms
 * for a known one is an account-enumeration oracle no matter what the response body says.
 *
 * The emailed-link flows of RFC platform-v2 §3-§4 live here too, because each of them ends in
 * either a session or a password change: `verifyEmail` and `acceptInvitation` spend a token,
 * activate the login and sign the person in; `requestPasswordReset` / `confirmPasswordReset`
 * are the reset. Each token spend and the user change it authorises are one transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import type {
  LoginResponse,
  MerchantId,
  SessionResponse,
  StaffSessionResponse,
  UserId,
  UserRole,
} from '@payzeno/contracts';

import { ConflictException } from '../common/errors/api.exception';
import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';
import { InvalidLinkTokenException } from '../common/errors/identity.exceptions';
import { MerchantNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { MerchantRepository } from '../merchants/merchant.repository';
import { toMerchantResponse } from '../merchants/merchants.service';
import { MerchantUserEntity } from '../merchants/users/merchant-user.entity';
import { MerchantUserRepository } from '../merchants/users/merchant-user.repository';
import { MerchantUserTokensService } from '../merchants/users/user-tokens.service';
import { EmailService } from '../notifications/email/email.service';
import { StaffUsersService } from '../staff/staff-users.service';

import { SessionService, type IssuedSession, type SessionOrigin } from './session/session.service';

/**
 * A hash of a value nobody knows, verified against on every miss so the failure path costs
 * the same as the success path. Generated once at boot, not checked in.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$0000000000000000000000000000000000000000000';

export interface LoginOutcome {
  issued: IssuedSession;
  body: LoginResponse;
}

export interface StaffLoginOutcome {
  issued: IssuedSession;
  body: StaffSessionResponse;
}

/**
 * Roles the console maps to UI affordances. Sent on `GET /v1/auth/me`.
 *
 * The vocabulary is the console's (`payzeno-console/src/types/nav.ts`, `PERMISSIONS` and
 * `ROLE_PERMISSIONS`): the console filters its navigation by these exact strings, and trusts
 * this list over its own table whenever it is non-empty. The old list here used api scope
 * names, so an owner matched one entry (`payouts:write`) and saw an empty navigation.
 */
const READ_PERMISSIONS = [
  'payments:read',
  'disputes:read',
  'balance:read',
  'payouts:read',
  'settlements:read',
  'invoices:read',
  'reporting:read',
  'settings:read',
];
const ADMIN_PERMISSIONS = [
  ...READ_PERMISSIONS,
  'payments:write',
  'refunds:write',
  'disputes:write',
  'payouts:write',
  'settlements:retry',
  'developers:read',
  'developers:write',
  'settings:write',
];
const PERMISSIONS_BY_ROLE: Readonly<Record<UserRole, string[]>> = {
  owner: [...ADMIN_PERMISSIONS, 'team:invite'],
  admin: ADMIN_PERMISSIONS,
  developer: [...READ_PERMISSIONS, 'developers:read', 'developers:write'],
  viewer: READ_PERMISSIONS,
};

@Injectable()
export class AuthService {
  constructor(
    private readonly users: MerchantUserRepository,
    private readonly merchants: MerchantRepository,
    private readonly sessions: SessionService,
    private readonly staff: StaffUsersService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    private readonly transactions: TransactionManager,
    private readonly tokens: MerchantUserTokensService,
    private readonly email: EmailService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Chain: AuthController.login → AuthService.login → MerchantUserRepository.findLoginCandidates
   *        → argon2.verify → SessionService.issue → SessionStore.create
   */
  async login(
    email: string,
    password: string,
    merchantId: MerchantId | null,
    origin: SessionOrigin,
  ): Promise<LoginOutcome> {
    const candidates = await this.users.findLoginCandidates(email.trim().toLowerCase());
    const matched = await this.verifyAgainst(candidates, password);

    if (matched.length === 0) {
      this.logger.info('auth.login_failed', { email_domain: domainOf(email) });
      throw new AuthenticationRequiredException('Invalid email or password');
    }

    const user = this.chooseMerchant(matched, merchantId);
    return this.signIn(user, origin);
  }

  /**
   * The Payzeno-operator login, `POST /v1/staff/auth/login`. Same store and CSRF as a merchant
   * login — the differences are which table the credential lives in, the cookie
   * (`pz_staff_session`) and that the resulting session carries no merchant.
   */
  async loginStaff(email: string, password: string, origin: SessionOrigin): Promise<StaffLoginOutcome> {
    /**
     * The verify, the disabled-account check and the `last_login_at` touch all live inside
     * `StaffUsersService.authenticate` — `staff_user.password_hash` never leaves that file,
     * which is the whole reason this branch delegates instead of reading the table itself.
     * A null answer covers "no such operator", "wrong password" and "disabled" alike.
     */
    const operator = await this.staff.authenticate(email.trim().toLowerCase(), password);

    if (!operator) {
      throw new AuthenticationRequiredException('Invalid email or password');
    }

    this.logger.info('auth.staff_login', { staff_id: operator.id, role: operator.role });

    const issued = await this.sessions.issueStaff(operator.id, operator.role, origin);
    return { issued, body: { object: 'staff_session', staff: operator.toStaffUser() } };
  }

  /** `GET /v1/staff/auth/me` — the admin app's bootstrap call. Also refreshes `pz_csrf`. */
  async describeStaffSession(sessionId: string): Promise<{ body: StaffSessionResponse; csrfToken: string }> {
    const record = await this.sessions.requireRecord(sessionId);

    if (record.kind !== 'staff' || !record.staffId) {
      throw new AuthenticationRequiredException('Not a staff session');
    }

    // Throws 403 for a disabled operator still holding a cookie, exactly as StaffGuard does.
    const operator = await this.staff.resolveActive(record.staffId);
    const csrfToken = await this.sessions.refreshCsrf(sessionId);

    return { csrfToken, body: { object: 'staff_session', staff: operator.toStaffUser() } };
  }

  /** `GET /v1/auth/me` — the console bootstrap call. Also refreshes `pz_csrf`. */
  async describeSession(sessionId: string): Promise<{ body: SessionResponse; csrfToken: string }> {
    const record = await this.sessions.requireRecord(sessionId);

    if (record.kind !== 'merchant_user' || !record.userId || !record.merchantId) {
      throw new AuthenticationRequiredException('Not a merchant session');
    }

    const user = await this.users.findByIdForMerchant(record.merchantId, record.userId);
    const merchant = await this.merchants.findById(record.merchantId);

    if (!user || !merchant) throw new AuthenticationRequiredException('Session subject no longer exists');

    const csrfToken = await this.sessions.refreshCsrf(sessionId);

    return {
      csrfToken,
      body: {
        object: 'session',
        user: user.toUser(),
        merchant: toMerchantResponse(merchant),
        permissions: PERMISSIONS_BY_ROLE[user.role],
      },
    };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    await this.sessions.destroy(sessionId);
  }

  /**
   * `POST /v1/signup/verify`. Spends the `email_verification` token, activates the owner the
   * signup created and signs them in. The merchant stays `pending_review` — verifying an
   * address is not KYC.
   */
  async verifyEmail(token: string, origin: SessionOrigin): Promise<LoginOutcome> {
    const subject = await this.transactions.runInTransaction(async (manager) => {
      const spent = await this.tokens.consume(token, 'email_verification', manager);
      const activated = await this.users.activateInvited(spent.merchantId, spent.userId, {}, manager);
      if (activated === 0) throw new InvalidLinkTokenException('token_invalid');
      return spent;
    });

    this.logger.info('auth.email_verified', { user_id: subject.userId, merchant_id: subject.merchantId });
    return this.signInById(subject.merchantId, subject.userId, origin);
  }

  /**
   * `POST /v1/auth/invitations/accept`. Spends the `invitation` token, sets the invitee's name
   * and password, activates the login and signs them in. The hash is computed before the
   * transaction opens: argon2 takes ~100ms and a row lock should not wait on it.
   */
  async acceptInvitation(
    token: string,
    fullName: string,
    password: string,
    origin: SessionOrigin,
  ): Promise<LoginOutcome> {
    const passwordHash = await hashPassword(password);

    const subject = await this.transactions.runInTransaction(async (manager) => {
      const spent = await this.tokens.consume(token, 'invitation', manager);
      const activated = await this.users.activateInvited(
        spent.merchantId,
        spent.userId,
        { passwordHash, fullName: fullName.trim() },
        manager,
      );
      // The invite was revoked (the user was removed) or already accepted another way.
      if (activated === 0) throw new InvalidLinkTokenException('token_invalid');
      return spent;
    });

    this.logger.info('auth.invitation_accepted', { user_id: subject.userId, merchant_id: subject.merchantId });
    return this.signInById(subject.merchantId, subject.userId, origin);
  }

  /**
   * `POST /v1/auth/password/reset`. Always 202, never leaks whether the address exists.
   *
   * One `password_reset` email per active login on the address — a person with logins at two
   * merchants gets two links, each naming its merchant, because they are two passwords. A new
   * request revokes the previous link. Sessions are NOT revoked here: anyone can ask for a
   * reset of anyone's address, and logging the owner out on an unauthenticated request is a
   * denial of service. `confirmPasswordReset` revokes them, once the password has changed.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const candidates = await this.users.findLoginCandidates(email.trim().toLowerCase());

    for (const user of candidates) {
      await this.transactions.runInTransaction(async (manager) => {
        const merchant = await this.merchants.findById(user.merchantId, manager);
        const token = await this.tokens.issue(user, 'password_reset', manager);
        await this.email.queue(
          {
            template: 'password_reset',
            to: user.email,
            data: {
              reset_url: `${this.config.publicUrls.console}/reset-password?token=${encodeURIComponent(token)}`,
              merchant_name: merchant?.displayName ?? null,
            },
            merchantId: user.merchantId,
          },
          manager,
        );
      });
      this.logger.info('auth.password_reset_requested', {
        user_id: user.id,
        merchant_id: user.merchantId,
      });
    }

    // No branch on `candidates.length`. The caller gets 202 either way.
  }

  /**
   * `POST /v1/auth/password/reset/confirm`. Spends the token, replaces the hash and revokes
   * every live session of that login — a reset that leaves the attacker's session alive resets
   * nothing. Does not sign anyone in; the console sends them to `/login`.
   */
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);

    const subject = await this.transactions.runInTransaction(async (manager) => {
      const spent = await this.tokens.consume(token, 'password_reset', manager);
      const replaced = await this.users.replacePassword(spent.merchantId, spent.userId, passwordHash, manager);
      if (replaced === 0) throw new InvalidLinkTokenException('token_invalid');
      return spent;
    });

    const revoked = await this.sessions.destroyAllForUser(subject.userId);
    this.logger.info('auth.password_reset_completed', {
      user_id: subject.userId,
      merchant_id: subject.merchantId,
      sessions_revoked: revoked,
    });
  }

  private async signInById(merchantId: MerchantId, userId: UserId, origin: SessionOrigin): Promise<LoginOutcome> {
    const user = await this.users.findByIdForMerchant(merchantId, userId);
    if (!user || !user.canLogIn()) {
      throw new AuthenticationRequiredException('This login is not active');
    }
    return this.signIn(user, origin);
  }

  private async signIn(user: MerchantUserEntity, origin: SessionOrigin): Promise<LoginOutcome> {
    const merchant = await this.merchants.findById(user.merchantId);

    if (!merchant) throw new MerchantNotFoundException(user.merchantId);

    const issued = await this.sessions.issue(user.id, user.merchantId, user.role, origin);
    await this.users.touchLastLogin(user.id, this.clock.now());

    return {
      issued,
      body: {
        object: 'login',
        user: user.toUser(),
        merchant: toMerchantResponse(merchant),
      },
    };
  }

  /** One verify per candidate, and one against the dummy when there are none. */
  private async verifyAgainst(
    candidates: MerchantUserEntity[],
    password: string,
  ): Promise<MerchantUserEntity[]> {
    if (candidates.length === 0) {
      await this.burnTime(password);
      return [];
    }

    const matched: MerchantUserEntity[] = [];

    for (const candidate of candidates) {
      const ok = await argon2.verify(candidate.passwordHash, password).catch(() => false);
      if (ok && candidate.canLogIn()) matched.push(candidate);
    }

    return matched;
  }

  private chooseMerchant(matched: MerchantUserEntity[], merchantId: MerchantId | null): MerchantUserEntity {
    if (merchantId) {
      const chosen = matched.find((user) => user.merchantId === merchantId);
      // Not 404: the address authenticated, it just does not have a login at that merchant.
      if (!chosen) throw new AuthenticationRequiredException('No login for that merchant');
      return chosen;
    }

    if (matched.length === 1) return matched[0];

    throw new ConflictException('This email has a login at more than one merchant', {
      reason: 'merchant_chooser_required',
      merchant_ids: matched.map((user) => user.merchantId).join(','),
    });
  }

  private async burnTime(password: string): Promise<boolean> {
    return argon2.verify(DUMMY_HASH, password).catch(() => false);
  }
}

/** argon2id, the same parameters `MerchantUsersService` and the seed use. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? 'unknown' : email.slice(at + 1);
}
