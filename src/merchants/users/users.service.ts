/**
 * MerchantUsersService — dashboard logins.
 *
 * ytechdebt's directory. It sits just above the 80% coverage gate and drags it down, which is
 * a fact about this file and not an aspiration.
 *
 * The one rule with teeth is `assertNotLastOwner`: removing the last `owner` leaves a merchant
 * nobody can administer, and the only fix is a staff operator with database access. It has
 * happened twice.
 */
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import type { ListQuery, MerchantId, Paginated, User, UserId, UserRole } from '@payzeno/contracts';

import { ValidationException } from '../../common/errors/api.exception';
import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { resolveListQuery } from '../../common/pagination/list-query.dto';
import { CLOCK, type Clock } from '../../common/time/clock';

import { MerchantUserEntity } from './merchant-user.entity';
import { MerchantUserRepository } from './merchant-user.repository';

export interface InviteUserInput {
  email: string;
  full_name: string;
  role: UserRole;
}

@Injectable()
export class MerchantUsersService {
  constructor(
    private readonly users: MerchantUserRepository,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async list(merchantId: MerchantId, query: ListQuery): Promise<Paginated<User>> {
    const resolved = resolveListQuery(query);
    const rows = await this.users.listForMerchant(merchantId, resolved.limit + 1);

    const hasMore = rows.length > resolved.limit;
    const data = hasMore ? rows.slice(0, resolved.limit) : rows;

    // TODO(PAY-1902): this list is not cursor-paginated like every other list in the API.
    // Nobody has more than ~40 dashboard users so it has never mattered, and the day it does
    // it will matter loudly.
    return { data: data.map((user) => user.toUser()), has_more: hasMore, next_cursor: null };
  }

  async get(merchantId: MerchantId, userId: UserId): Promise<User> {
    const user = await this.users.findByIdForMerchant(merchantId, userId);
    if (!user) throw new ResourceNotFoundException('user', userId);
    return user.toUser();
  }

  /**
   * Invite. The row is created with a random password hash and `status: 'invited'`; the
   * invitee sets a real password through the reset flow.
   *
   * TODO(PAY-1907): the invitation email itself is not sent from here — it is not sent from
   * anywhere. The console tells the admin to forward the reset link manually.
   */
  async invite(merchantId: MerchantId, input: InviteUserInput): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findByEmailForMerchant(merchantId, email);

    if (existing) {
      throw new ValidationException('That email already has a login at this merchant', [
        { path: 'email', code: 'duplicate', message: 'already invited' },
      ]);
    }

    const user = new MerchantUserEntity();
    const now = this.clock.now();

    user.id = this.ids.userId();
    user.merchantId = merchantId;
    user.email = email;
    user.fullName = input.full_name.trim();
    user.role = input.role;
    user.status = 'invited';
    user.passwordHash = await argon2.hash(unguessablePlaceholder());
    user.lastLoginAt = null;
    user.createdAt = now;
    user.updatedAt = now;

    await this.users.insertMapped(user);

    this.logger.info('merchant_user.invited', {
      merchant_id: merchantId,
      user_id: user.id,
      role: user.role,
    });

    return user.toUser();
  }

  async changeRole(merchantId: MerchantId, userId: UserId, role: UserRole): Promise<User> {
    const user = await this.users.findByIdForMerchant(merchantId, userId);
    if (!user) throw new ResourceNotFoundException('user', userId);

    if (user.role === 'owner' && role !== 'owner') {
      await this.assertNotLastOwner(merchantId);
    }

    await this.users.updateRole(merchantId, userId, role);
    return this.get(merchantId, userId);
  }

  /**
   * `DELETE /v1/merchants/:merchantId/users/:userId`. A status change, not a DELETE —
   * `audit_log.actor_id` points at these rows and a removed user makes six months of trail
   * unattributable.
   */
  async remove(merchantId: MerchantId, userId: UserId, actingUserId: UserId | null): Promise<void> {
    const user = await this.users.findByIdForMerchant(merchantId, userId);
    if (!user) throw new ResourceNotFoundException('user', userId);

    if (actingUserId === userId) {
      throw new PermissionDeniedException('You cannot remove your own login');
    }

    if (user.role === 'owner') {
      await this.assertNotLastOwner(merchantId);
    }

    await this.users.disable(merchantId, userId);
    this.logger.info('merchant_user.removed', { merchant_id: merchantId, user_id: userId });
  }

  private async assertNotLastOwner(merchantId: MerchantId): Promise<void> {
    const owners = await this.users.countOwners(merchantId);

    if (owners <= 1) {
      throw new ValidationException('A merchant must keep at least one owner', [
        { path: 'role', code: 'last_owner', message: 'demote or remove another owner first' },
      ]);
    }
  }
}

/** Not a real password and never used as one — the invitee resets before they can log in. */
function unguessablePlaceholder(): string {
  return `invite-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
