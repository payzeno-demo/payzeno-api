/**
 * L1. The only code that writes `merchant_user`.
 *
 * `password_hash` is `select: false` on the entity, so every read that needs it says so
 * explicitly via `addSelect`. That is not ceremony: without it the hash rides along in every
 * `GET /v1/merchants/:id/users` response object that somebody later spreads into a DTO.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import type { MerchantId, UserId, UserRole } from '@payzeno/contracts';

import { PayzenoRepository } from '../../common/persistence/payzeno.repository';

import { MerchantUserEntity } from './merchant-user.entity';

@Injectable()
export class MerchantUserRepository extends PayzenoRepository<MerchantUserEntity> {
  constructor(dataSource: DataSource) {
    super(MerchantUserEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'merchant_user';
  }

  /**
   * The login lookup. Returns a SET because email is unique per merchant, not globally —
   * `AuthService.login` turns a set of size > 1 into a merchant chooser rather than picking
   * one arbitrarily. `ix_merchant_user_email` is what makes this an index scan.
   *
   * Includes `password_hash`; this is the one place that does. `addSelect` takes the PROPERTY
   * (`passwordHash`): given the column name it selects a raw value that never reaches the
   * entity, and every login fails the verify against `undefined`.
   */
  findLoginCandidates(email: string): Promise<MerchantUserEntity[]> {
    return this.createQueryBuilder('merchant_user')
      .addSelect('merchant_user.passwordHash')
      .where('merchant_user.email = :email', { email })
      .andWhere("merchant_user.status = 'active'")
      .orderBy('merchant_user.created_at', 'ASC')
      .getMany();
  }

  findByEmailForMerchant(merchantId: MerchantId, email: string): Promise<MerchantUserEntity | null> {
    return this.createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .andWhere('merchant_user.email = :email', { email })
      .getOne();
  }

  findByIdForMerchant(
    merchantId: MerchantId,
    userId: UserId,
    manager?: EntityManager,
  ): Promise<MerchantUserEntity | null> {
    const repo = manager ? manager.getRepository(MerchantUserEntity) : this;
    return repo
      .createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .andWhere('merchant_user.id = :userId', { userId })
      .getOne();
  }

  listForMerchant(merchantId: MerchantId, limit: number): Promise<MerchantUserEntity[]> {
    return this.createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .orderBy('merchant_user.created_at', 'DESC')
      .take(limit)
      .getMany();
  }

  /** Login timestamp. Fire-and-forget from `AuthService` — a failed touch must not 500 a login. */
  async touchLastLogin(userId: UserId, at: Date): Promise<void> {
    await this.createQueryBuilder()
      .update()
      .set({ lastLoginAt: at })
      .where('id = :userId', { userId })
      .execute();
  }

  async updateRole(
    merchantId: MerchantId,
    userId: UserId,
    role: UserRole,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager ? manager.getRepository(MerchantUserEntity) : this;
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ role })
      .where('id = :userId', { userId })
      .andWhere('merchant_id = :merchantId', { merchantId })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Removal is a status change, not a DELETE. `audit_log.actor_id` points at these rows and a
   * deleted user makes six months of audit trail unattributable.
   */
  async disable(merchantId: MerchantId, userId: UserId, manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(MerchantUserEntity) : this;
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ status: 'disabled' })
      .where('id = :userId', { userId })
      .andWhere('merchant_id = :merchantId', { merchantId })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Sets a known password and makes the login usable, whatever its status. The demo seed is the
   * only caller: real people go through `activateInvited` (invite / verify) or
   * `replacePassword` (reset), which are conditional on status. The hash is computed by the
   * caller — this never sees a plaintext password.
   */
  async activateWithPassword(merchantId: MerchantId, userId: UserId, passwordHash: string): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(MerchantUserEntity)
      .set({ passwordHash, status: 'active' })
      .where('id = :userId AND merchant_id = :merchantId', { userId, merchantId })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * An `invited` login becomes usable: the invitee accepted, or a signup owner clicked the
   * verification link. Conditional on `invited`, so a link replayed against a login that is
   * already active (or was removed since) changes nothing and returns 0.
   */
  async activateInvited(
    merchantId: MerchantId,
    userId: UserId,
    patch: { passwordHash?: string; fullName?: string },
    manager: EntityManager,
  ): Promise<number> {
    const result = await manager
      .getRepository(MerchantUserEntity)
      .createQueryBuilder()
      .update()
      .set({ ...patch, status: 'active' })
      .where('id = :userId AND merchant_id = :merchantId', { userId, merchantId })
      .andWhere("status = 'invited'")
      .execute();
    return result.affected ?? 0;
  }

  /** Password reset. Only an `active` login has a password worth resetting. */
  async replacePassword(
    merchantId: MerchantId,
    userId: UserId,
    passwordHash: string,
    manager: EntityManager,
  ): Promise<number> {
    const result = await manager
      .getRepository(MerchantUserEntity)
      .createQueryBuilder()
      .update()
      .set({ passwordHash })
      .where('id = :userId AND merchant_id = :merchantId', { userId, merchantId })
      .andWhere("status = 'active'")
      .execute();
    return result.affected ?? 0;
  }

  /** Who gets the merchant's operational email (disputes, payouts, onboarding decisions). */
  listActiveByRoles(
    merchantId: MerchantId,
    roles: readonly UserRole[],
    manager?: EntityManager,
  ): Promise<MerchantUserEntity[]> {
    const repo = manager ? manager.getRepository(MerchantUserEntity) : this;
    return repo
      .createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .andWhere('merchant_user.role in (:...roles)', { roles: [...roles] })
      .andWhere("merchant_user.status = 'active'")
      .orderBy('merchant_user.created_at', 'ASC')
      .getMany();
  }

  /** The earliest non-removed owner of each merchant — the admin list's `owner_email`. */
  async ownerEmailsFor(merchantIds: readonly MerchantId[]): Promise<Map<MerchantId, string>> {
    const owners = new Map<MerchantId, string>();
    if (merchantIds.length === 0) return owners;

    const rows = await this.find({
      where: { merchantId: In([...merchantIds]), role: 'owner' },
      order: { createdAt: 'ASC' },
    });
    for (const row of rows) {
      if (row.status !== 'disabled' && !owners.has(row.merchantId)) owners.set(row.merchantId, row.email);
    }
    return owners;
  }

  countOwners(merchantId: MerchantId): Promise<number> {
    return this.createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .andWhere("merchant_user.role = 'owner'")
      .andWhere("merchant_user.status = 'active'")
      .getCount();
  }
}
