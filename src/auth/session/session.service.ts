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

/**
 * The staff back office's own cookie (RFC platform-v2 §1). Same store, same record shape, same
 * `pz_csrf` double-submit — but a different name, so a browser holding both a merchant login
 * and a staff login never presents one where the other was expected, and logging out of the
 * console cannot end an operator's admin session (or the other way round).
 */
export const STAFF_SESSION_COOKIE = 'pz_staff_session';

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

/** The two methods of a response that setting a session needs. Express's satisfies it. */
export interface SessionCookieWriter {
  cookie(name: string, value: string, options: object): void;
}

/**
 * The two methods of the response object the auth controllers touch. Typed here rather than by
 * importing express, which keeps the controllers testable with a plain object and keeps the
 * platform out of the layer.
 */
export interface CookieResponse {
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options?: CookieOptions): void;
}

/** The flags SessionService and CsrfService actually set — a subset of express's own. */
export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
}

/** What a newly issued session records about where it came from (user agent, client IP). */
export function originOf(request: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): SessionOrigin {
  const raw = request.headers['user-agent'];
  const userAgent = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return { userAgent, ip: request.ip ?? null };
}

/** Sets the session cookie and `pz_csrf`. Every route that logs someone in ends here. */
export function writeSessionCookies(response: SessionCookieWriter, issued: IssuedSession): void {
  response.cookie(issued.sessionCookie.name, issued.sessionCookie.value, issued.sessionCookie.options);
  response.cookie(issued.csrfCookie.name, issued.csrfCookie.value, issued.csrfCookie.options);
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
   * A Payzeno operator's session. Same store, same CSRF, its own cookie (`pz_staff_session`).
   * It carries no merchant, so every merchant-scoped staff route has to name one with
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

    return this.issued(record, STAFF_SESSION_COOKIE);
  }

  private newRecord(
    origin: SessionOrigin,
    subject: Pick<SessionRecord, 'kind' | 'userId' | 'merchantId' | 'role' | 'staffId' | 'staffRole'>,
  ): SessionRecord {
    return {
      id: randomBytes(32).toString('base64url'),
      ...subject,
      csrfToken: this.csrf.mint(),
      createdAtMs: this.clock.nowMs(),
      lastSeenAtMs: this.clock.nowMs(),
      userAgent: origin.userAgent ? origin.userAgent.slice(0, 200) : null,
      ip: origin.ip,
    };
  }

  private issued(record: SessionRecord, cookieName: string = SESSION_COOKIE): IssuedSession {
    return {
      record,
      sessionCookie: { name: cookieName, value: record.id, options: this.sessionCookieOptions() },
      csrfCookie: { name: this.csrf.name, value: record.csrfToken, options: this.csrf.cookieOptions() },
    };
  }

  /**
   * The guard path. Asserts CSRF *before* sliding the TTL, so a rejected request cannot keep
   * a stolen session alive.
   */
  async resolve(sessionId: string | undefined, method: string, csrfHeader: string | undefined): Promise<AuthPrincipal> {
    const record = await this.requireRecord(sessionId);

    this.csrf.assert(method, csrfHeader, record.csrfToken);
    await this.store.touch(record.id, this.ttlSec);

    return this.toPrincipal(record, null);
  }

  /**
   * StaffGuard's entry point. `actingMerchantId` comes off `?merchant_id=` and is null on the
   * platform-wide routes; it is NOT read from the record, because a staff operator may act on
   * a different merchant on every request of one session.
   */
  async resolveStaff(
    sessionId: string | undefined,
    method: string,
    csrfHeader: string | undefined,
    actingMerchantId: MerchantId | null,
  ): Promise<AuthPrincipal | null> {
    const record = await this.requireRecord(sessionId);
    if (record.kind !== 'staff') return null;

    this.csrf.assert(method, csrfHeader, record.csrfToken);
    await this.store.touch(record.id, this.ttlSec);

    return this.toPrincipal(record, actingMerchantId);
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

  async destroy(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    await this.store.destroy(sessionId);
  }

  /** The controller sets `pz_csrf` on login and on `/me`; the flags live with the service. */
  get csrfCookieName(): string {
    return this.csrf.name;
  }

  csrfCookieOptions(): ReturnType<CsrfService['cookieOptions']> {
    return this.csrf.cookieOptions();
  }

  /** Password reset and role revocation both land here. */
  async destroyAllForUser(userId: UserId): Promise<number> {
    return this.store.destroyAllForUser(userId);
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
  expiredCookies(
    sessionCookieName: string = SESSION_COOKIE,
  ): Array<{ name: string; value: string; options: { path: '/'; maxAge: 0 } }> {
    return [
      { name: sessionCookieName, value: '', options: { path: '/', maxAge: 0 } },
      { name: this.csrf.name, value: '', options: { path: '/', maxAge: 0 } },
    ];
  }
}
