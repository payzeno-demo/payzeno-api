/**
 * L1. The only code that writes `merchant_user_token`.
 *
 * `consume` is a conditional UPDATE, not a read-then-write: two clicks on the same emailed link
 * (a double-submit, a mail scanner prefetching it, two tabs) race, and exactly one of them sees
 * `affected = 1`.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import type { UserId } from '@payzeno/contracts';

import { PayzenoRepository, toInsertRow } from '../../common/persistence/payzeno.repository';

import { MerchantUserTokenEntity, type MerchantUserTokenPurpose } from './merchant-user-token.entity';

@Injectable()
export class MerchantUserTokenRepository extends PayzenoRepository<MerchantUserTokenEntity> {
  constructor(dataSource: DataSource) {
    super(MerchantUserTokenEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'merchant_user_token';
  }

  async append(row: MerchantUserTokenEntity, manager: EntityManager): Promise<void> {
    await this.insertMapped(toInsertRow(row), manager);
  }

  findByHash(tokenHash: string, manager?: EntityManager): Promise<MerchantUserTokenEntity | null> {
    const repo = manager ? manager.getRepository(MerchantUserTokenEntity) : this;
    return repo.findOne({ where: { tokenHash } });
  }

  /** Every still-usable token of this purpose for this user is spent. Returns how many. */
  async revokeLive(
    userId: UserId,
    purpose: MerchantUserTokenPurpose,
    at: Date,
    manager: EntityManager,
  ): Promise<number> {
    const result = await manager
      .getRepository(MerchantUserTokenEntity)
      .createQueryBuilder()
      .update()
      .set({ consumedAt: at })
      .where('user_id = :userId', { userId })
      .andWhere('purpose = :purpose', { purpose })
      .andWhere('consumed_at is null')
      .execute();
    return result.affected ?? 0;
  }

  /** 1 when this call spent the token, 0 when it was already spent or has expired. */
  async consume(id: string, at: Date, manager: EntityManager): Promise<number> {
    const result = await manager
      .getRepository(MerchantUserTokenEntity)
      .createQueryBuilder()
      .update()
      .set({ consumedAt: at })
      .where('id = :id', { id })
      .andWhere('consumed_at is null')
      .andWhere('expires_at > :at', { at })
      .execute();
    return result.affected ?? 0;
  }
}
