/**
 * SessionService — mint, resolve, slide, destroy.
 *
 * It owns the cookie shapes as well as the records, because the two are one decision:
 * `pz_session` is HttpOnly and `pz_csrf` is not, and splitting that knowledge across the
 * controller and the store is how one of them ends up with the wrong flags after a refactor.
 *
 * Chain from a console request:
 *   SessionGuard.canActivate → SessionService.resolve → SessionStore.get → PrincipalFactory
 */
import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { AuthPrincipal, MerchantId, StaffRole, UserId, UserRole } from '@payzeno/contracts';

import { AuthenticationRequiredException } from '../../common/errors/auth.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { CLOCK, type Clock } from '../../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { PrincipalFactory } from '../principal/principal.factory';

import { CsrfService } from './csrf.service';
import { SESSION_STORE, type SessionRecord, type SessionStore } from './session.store';

export const SESSION_COOKIE = 'pz_session';

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export interface IssuedSession {
  record: SessionRecord;
  sessionCookie: { name: string; value: string; options: SessionCookieOptions };
  csrfCookie: { name: string; value: string; options: ReturnType<CsrfService['cookieOptions']> };
}

export interface SessionOrigin {
  userAgent: string | null;
  ip: string | null;
}

@Injectable()
export class SessionService {
  private readonly ttlSec: number;
  private readonly secureCookies: boolean;

  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    private readonly csrf: CsrfService,
    private readonly principals: PrincipalFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {
    this.ttlSec = config.auth.sessionTtlSeconds;
    this.secureCookies = config.runtime.nodeEnv === 'production';
  }

  /** `POST /v1/auth/login`, once AuthService has verified the password. */
  async issue(
    userId: UserId,
    merchantId: MerchantId,
    role: UserRole,
    origin: SessionOrigin,
  ): Promise<IssuedSession> {
    const record = this.newRecord(origin, {
      kind: 'merchant_user',
      userId,
      merchantId,
      role,
      staffId: null,
      staffRole: null,
    });

    await this.store.create(record, this.ttlSec);
    this.logger.info('session.issued', { user_id: userId, merchant_id: merchantId, role });

    return this.issued(record);
  }

  /**
   * A Payzeno operator's session. Same cookie, same store, same CSRF — the difference is that
   * it carries no merchant, so every merchant-scoped staff route has to name one with
   * `?merchant_id=` and MerchantScopeGuard is what enforces that.
   */
  async issueStaff(staffId: string, staffRole: StaffRole, origin: SessionOrigin): Promise<IssuedSession> {
    const record = this.newRecord(origin, {
      kind: 'staff',
      userId: null,
      merchantId: null,
      role: null,
      staffId,
      staffRole,
    });

    await this.store.create(record, this.ttlSec);
    this.logger.info('session.issued_staff', { staff_id: staffId, role: staffRole });

    return this.issued(record);
  }

  /** The one place a record becomes a principal, so the two kinds cannot be confused. */
  private toPrincipal(record: SessionRecord, actingMerchantId: MerchantId | null): AuthPrincipal {
    if (record.kind === 'staff') {
      return this.principals.fromStaff(record.staffId ?? 'stf_unknown', record.staffRole ?? 'support', actingMerchantId);
    }

    if (!record.merchantId || !record.userId || !record.role) {
      throw new AuthenticationRequiredException('Session record is missing its merchant binding');
    }

    return this.principals.fromSessionRecord(record.merchantId, record.userId, record.role);
  }

  /** For the WebSocket upgrade, which has no method to branch on and no body to protect. */
  async resolveForUpgrade(sessionId: string | undefined, csrfHeader: string | undefined): Promise<AuthPrincipal> {
    const record = await this.requireRecord(sessionId);
    this.csrf.assert('POST', csrfHeader, record.csrfToken);
    return this.toPrincipal(record, null);
  }

  async requireRecord(sessionId: string | undefined): Promise<SessionRecord> {
    if (!sessionId) throw new AuthenticationRequiredException('No session cookie presented');

    const record = await this.store.get(sessionId);
    if (!record) throw new AuthenticationRequiredException('Session expired or unknown');

    return record;
  }

  /** `GET /v1/auth/me` refreshes the CSRF cookie; the console calls it on every boot. */
  async refreshCsrf(sessionId: string): Promise<string> {
    const record = await this.requireRecord(sessionId);
    await this.store.touch(record.id, this.ttlSec);
    return record.csrfToken;
  }

  csrfCookieOptions(): ReturnType<CsrfService['cookieOptions']> {
    return this.csrf.cookieOptions();
  }

  private sessionCookieOptions(): SessionCookieOptions {
    return {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: this.ttlSec * 1000,
    };
  }

  /** Cookie clears are cookie sets with maxAge 0 — same flags, or the browser keeps them. */
  expiredCookies(): Array<{ name: string; value: string; options: { path: '/'; maxAge: 0 } }> {
    return [
      { name: SESSION_COOKIE, value: '', options: { path: '/', maxAge: 0 } },
      { name: this.csrf.name, value: '', options: { path: '/', maxAge: 0 } },
    ];
  }
}
