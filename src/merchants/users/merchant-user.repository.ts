/**
 * L1. The only code that writes `merchant_user`.
 *
 * `password_hash` is `select: false` on the entity, so every read that needs it says so
 * explicitly via `addSelect`. That is not ceremony: without it the hash rides along in every
 * `GET /v1/merchants/:id/users` response object that somebody later spreads into a DTO.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

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
   * Includes `password_hash`; this is the one place that does.
   */
  findLoginCandidates(email: string): Promise<MerchantUserEntity[]> {
    return this.createQueryBuilder('merchant_user')
      .addSelect('merchant_user.password_hash')
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

  findByIdForMerchant(merchantId: MerchantId, userId: UserId): Promise<MerchantUserEntity | null> {
    return this.createQueryBuilder('merchant_user')
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

  /** The last owner cannot be removed — otherwise nobody can ever administer the merchant. */
  countOwners(merchantId: MerchantId): Promise<number> {
    return this.createQueryBuilder('merchant_user')
      .where('merchant_user.merchant_id = :merchantId', { merchantId })
      .andWhere("merchant_user.role = 'owner'")
      .andWhere("merchant_user.status = 'active'")
      .getCount();
  }
}
