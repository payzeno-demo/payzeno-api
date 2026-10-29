/**
 * MerchantUsersService — dashboard logins.
 *
 * ytechdebt's directory. It sits just above the 80% coverage gate and drags it down, which is
 * a fact about this file and not an aspiration.
 *
 * The one rule with teeth is `assertNotLastOwner`: removing the last `owner` leaves a merchant
 * nobody can administer, and the only fix is a staff operator with database access. It has
 * happened twice.
 *
 * `invite` is RFC platform-v2 §4: the row, a single-use invitation token (72h) and the
 * `team_invite` email commit in one transaction. Inviting an address that is still `invited`
 * re-sends — a fresh link, the old one revoked — instead of refusing: "I never got the email"
 * is the most common thing a new teammate says.
 */
import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { EntityManager } from 'typeorm';

import type { ListQuery, MerchantId, Paginated, User, UserId, UserRole } from '@payzeno/contracts';

import { ValidationException } from '../../common/errors/api.exception';
import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { resolveListQuery } from '../../common/pagination/list-query.dto';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { EmailService } from '../../notifications/email/email.service';
import { MerchantRepository } from '../merchant.repository';

import { MerchantUserEntity, type MerchantUserStatus } from './merchant-user.entity';
import { MerchantUserRepository } from './merchant-user.repository';
import { MerchantUserTokensService } from './user-tokens.service';

export interface InviteUserInput {
  email: string;
  full_name: string;
  role: UserRole;
}

/** How a login is born when it is not invited: a signup owner, or the demo seed. */
export interface NewUserCredentials {
  status: MerchantUserStatus;
  /** argon2id, computed by the caller. */
  passwordHash: string;
}

/** Who the invitation says it is from when a Payzeno operator invites on a merchant's behalf. */
const STAFF_INVITER_NAME = 'The Payzeno team';

@Injectable()
export class MerchantUsersService {
  constructor(
    private readonly users: MerchantUserRepository,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    private readonly transactions: TransactionManager,
    private readonly tokens: MerchantUserTokensService,
    private readonly email: EmailService,
    private readonly merchants: MerchantRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
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
   * `POST /v1/merchants/:merchantId/users`. The row is created `invited` with an unusable
   * password hash; the invitee chooses a real one on `POST /v1/auth/invitations/accept`, with the
   * token this emails. `invitedBy` is the inviting merchant user, or null for a staff operator.
   */
  async invite(merchantId: MerchantId, input: InviteUserInput, invitedBy: UserId | null = null): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findByEmailForMerchant(merchantId, email);

    if (existing && existing.status !== 'invited') {
      throw new ValidationException('That email already has a login at this merchant', [
        { path: 'email', code: 'duplicate', message: 'already a member' },
      ]);
    }

    const merchant = await this.merchants.findById(merchantId);
    if (!merchant) throw new ResourceNotFoundException('merchant', merchantId);
    const inviterName = await this.inviterName(merchantId, invitedBy);

    return this.transactions.runInTransaction(async (manager) => {
      const user =
        existing ??
        (await this.createUser(
          merchantId,
          input,
          { status: 'invited', passwordHash: await argon2.hash(unguessablePlaceholder()) },
          manager,
        ));

      const token = await this.tokens.issue(user, 'invitation', manager);
      await this.email.queue(
        {
          template: 'team_invite',
          to: user.email,
          data: {
            inviter_name: inviterName,
            merchant_name: merchant.displayName,
            accept_url: `${this.config.publicUrls.console}/accept-invite?token=${encodeURIComponent(token)}`,
          },
          merchantId,
        },
        manager,
      );

      this.logger.info(existing ? 'merchant_user.invite_resent' : 'merchant_user.invited', {
        merchant_id: merchantId,
        user_id: user.id,
        role: user.role,
      });
      return user.toUser();
    });
  }

  /**
   * A login that is not invited by a teammate: the owner a signup creates (`invited`, with the
   * password they chose, until they verify the address) and the demo seed's known users.
   */
  async createUser(
    merchantId: MerchantId,
    input: InviteUserInput,
    credentials: NewUserCredentials,
    manager?: EntityManager,
  ): Promise<MerchantUserEntity> {
    const user = new MerchantUserEntity();
    const now = this.clock.now();

    user.id = this.ids.userId();
    user.merchantId = merchantId;
    user.email = input.email.trim().toLowerCase();
    user.fullName = input.full_name.trim();
    user.role = input.role;
    user.status = credentials.status;
    user.passwordHash = credentials.passwordHash;
    user.lastLoginAt = null;
    user.createdAt = now;
    user.updatedAt = now;

    await this.users.insertMapped(user, manager);
    return user;
  }

  private async inviterName(merchantId: MerchantId, invitedBy: UserId | null): Promise<string> {
    if (!invitedBy) return STAFF_INVITER_NAME;
    const inviter = await this.users.findByIdForMerchant(merchantId, invitedBy);
    return inviter?.fullName ?? STAFF_INVITER_NAME;
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
  return `invite-${randomBytes(24).toString('base64url')}`;
}
