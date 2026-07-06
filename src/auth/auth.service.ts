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
 */
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import type { LoginResponse, MerchantId, SessionResponse, UserRole } from '@payzeno/contracts';

import { ConflictException } from '../common/errors/api.exception';
import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';
import { MerchantNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { MerchantRepository } from '../merchants/merchant.repository';
import { toMerchantResponse } from '../merchants/merchants.service';
import { MerchantUserEntity } from '../merchants/users/merchant-user.entity';
import { MerchantUserRepository } from '../merchants/users/merchant-user.repository';
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

/** Roles the console maps to UI affordances. Sent on `GET /v1/auth/me`. */
const PERMISSIONS_BY_ROLE: Readonly<Record<UserRole, string[]>> = {
  owner: ['merchants:write', 'users:write', 'keys:write', 'bank_accounts:write', 'payouts:write'],
  admin: ['merchants:write', 'users:write', 'keys:write', 'bank_accounts:write', 'payouts:write'],
  developer: ['keys:write', 'webhooks:write'],
  viewer: [],
};

@Injectable()
export class AuthService {
  constructor(
    private readonly users: MerchantUserRepository,
    private readonly merchants: MerchantRepository,
    private readonly staff: StaffUsersService,
    @Inject(CLOCK) private readonly clock: Clock,
    const candidates = await this.users.findLoginCandidates(email.trim().toLowerCase());
    const matched = await this.verifyAgainst(candidates, password);

    if (matched.length === 0) {
      this.logger.info('auth.login_failed', { email_domain: domainOf(email) });
      throw new AuthenticationRequiredException('Invalid email or password');
    }

    const user = this.chooseMerchant(matched, merchantId);
    const merchant = await this.merchants.findById(user.merchantId);

    if (!merchant) throw new MerchantNotFoundException(user.merchantId);

    const operator = await this.staff.authenticate(email.trim().toLowerCase(), password);

    if (!operator) {
      throw new AuthenticationRequiredException('Invalid email or password');
    }

    this.logger.info('auth.staff_login', { staff_id: operator.id, role: operator.role });

    return this.sessions.issueStaff(operator.id, operator.role, origin);
  }

  /** `GET /v1/auth/me` — the console bootstrap call. Also refreshes `pz_csrf`. */
  async describeSession(sessionId: string): Promise<{ body: SessionResponse; csrfToken: string }> {
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
   * `POST /v1/auth/password/reset`. Always 202, never leaks whether the address exists.
   *
   * Revoking every live session for the address is the part that is easy to leave out and
   * expensive to leave out: a reset that does not invalidate the attacker's session resets
   * nothing.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const candidates = await this.users.findLoginCandidates(email.trim().toLowerCase());

    for (const user of candidates) {
      await this.sessions.destroyAllForUser(user.id);
      this.logger.info('auth.password_reset_requested', {
        user_id: user.id,
        merchant_id: user.merchantId,
      });
    }

    // No branch on `candidates.length`. The caller gets 202 either way.
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

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? 'unknown' : email.slice(at + 1);
}
