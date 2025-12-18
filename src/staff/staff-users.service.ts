/**
 * StaffUsersService — resolution and lifecycle for `staff_user`.
 *
 * AuthService calls `authenticate()` on the staff branch of `POST /v1/auth/login`; StaffGuard
 * calls `resolveActive()` on every `@StaffOnly()` handler. Nothing else may read the table:
 * the password hash never leaves this file, and neither does the constant-time verify.
 *
 * docs/adr/0001-nestjs-module-boundaries.md — this service imports persistence and
 * primitives only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { IsNull, Repository } from 'typeorm';

import type { StaffRole } from '@payzeno/contracts';

import { PermissionDeniedException } from '../common/errors/auth.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';

import { StaffUser } from './staff-user.entity';

export interface CreateStaffUserInput {
  email: string;
  fullName: string;
  password: string;
  role: StaffRole;
}

@Injectable()
export class StaffUsersService {
  constructor(
    @InjectRepository(StaffUser) private readonly staff: Repository<StaffUser>,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Credential check. Returns null for "no such operator" and for "wrong password" alike —
   * a distinguishable answer here enumerates the platform's own staff directory.
   */
  async authenticate(email: string, password: string): Promise<StaffUser | null> {
    const user = await this.staff.findOne({ where: { email: email.trim() } });

    if (!user) {
      // Still spend the argon2 budget so the timing does not answer the question.
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return null;
    }

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      this.logger.warn('staff.login_failed', { staff_id: user.id, reason: 'bad_password' });
      return null;
    }

    if (!user.isActive()) {
      this.logger.warn('staff.login_failed', { staff_id: user.id, reason: 'disabled' });
      return null;
    }

    await this.staff.update({ id: user.id }, { lastLoginAt: this.clock.now() });
    return user;
  }

  /**
   * StaffGuard's lookup. Throws rather than returning null: a session that carries a
   * `staff_id` which no longer resolves to an active operator is a revoked account still
   * holding a cookie, and that is a 403 every time.
   */
  async resolveActive(staffId: string): Promise<StaffUser> {
    const user = await this.staff.findOne({ where: { id: staffId, disabledAt: IsNull() } });

    if (!user) {
      throw new PermissionDeniedException('staff account is disabled or unknown');
    }
    return user;
  }

  /** `@StaffOnly('risk','finance')` — the check the guard performs after resolution. */
  async assertRole(staffId: string, required: readonly StaffRole[]): Promise<StaffUser> {
    const user = await this.resolveActive(staffId);

    if (!user.satisfies(required)) {
      this.logger.warn('staff.role_denied', {
        staff_id: user.id,
        role: user.role,
        required: required.join(','),
      });
      throw new PermissionDeniedException(
        `staff role "${user.role}" does not satisfy ${required.join('|')}`,
      );
    }
    return user;
  }

  async create(input: CreateStaffUserInput): Promise<StaffUser> {
    const now = this.clock.now();
    const user = new StaffUser();

    user.id = this.ids.opaque('stf_');
    user.email = input.email.trim().toLowerCase();
    user.fullName = input.fullName;
    user.passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    user.role = input.role;
    user.mfaEnrolled = false;
    user.lastLoginAt = null;
    user.disabledAt = null;
    user.createdAt = now;
    user.updatedAt = now;

    await this.staff.insert(user);
    this.logger.info('staff.created', { staff_id: user.id, role: user.role });
    return user;
  }

  /** Disable, never delete — `staff_audit_log` holds a restrict-mode foreign key. */
  async disable(staffId: string): Promise<StaffUser> {
    const user = await this.resolveActive(staffId);
    await this.staff.update({ id: user.id }, { disabledAt: this.clock.now() });
    this.logger.info('staff.disabled', { staff_id: user.id, role: user.role });
    return user;
  }

  async listActive(role?: StaffRole): Promise<StaffUser[]> {
    return this.staff.find({
      where: role ? { role, disabledAt: IsNull() } : { disabledAt: IsNull() },
      order: { fullName: 'ASC' },
      take: 200,
    });
  }

  /**
   * The on-call rota reads this to check that every escalation role still has a body behind
   * it. An empty `finance` list means nobody can retry a settlement item.
   */
  async coverageByRole(): Promise<Record<StaffRole, number>> {
    const active = await this.listActive();
    const coverage: Record<StaffRole, number> = { support: 0, risk: 0, finance: 0, admin: 0 };

    for (const user of active) {
      coverage[user.role] += 1;
    }
    return coverage;
  }
}

/** A real argon2id hash of a value nobody has, so the miss path costs the same as the hit. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c3RhZmZ1c2Vyc2VydmljZQ$Y0Ke3ZTb1L0mNaXG5nQOZBqfLGP4qYJ7nX8mDpVQAAA';
