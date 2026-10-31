/**
 * L1. The only writer of `review`.
 *
 * Two read shapes: merchant-scoped (`/v1/reviews`, the inherited `paginateCursor`) and
 * cross-tenant for the admin queue (`listAll`), which is only reachable behind
 * `@StaffOnly('risk')`. Closing is conditional on `status = 'open'`, so two analysts clicking
 * at once produce one decision and one 409.
 */
import { Injectable } from '@nestjs/common';
import type { MerchantId, Paginated, ReviewStatus, StaffUserId } from '@payzeno/contracts';
import { DataSource, type EntityManager } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../common/pagination/list-query.dto';
import { applyCursor, toPage } from '../common/persistence/cursor';
import { PayzenoRepository, toInsertRow } from '../common/persistence/payzeno.repository';

import { ReviewEntity } from './review.entity';

@Injectable()
export class ReviewRepository extends PayzenoRepository<ReviewEntity> {
  constructor(dataSource: DataSource) {
    super(ReviewEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'review';
  }

  async insertReview(manager: EntityManager, row: ReviewEntity): Promise<ReviewEntity> {
    await this.insertMapped(toInsertRow(row), manager);
    return row;
  }

  listScoped(scope: MerchantScope, query: ResolvedListQuery, status?: ReviewStatus): Promise<Paginated<ReviewEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      status ? qb.andWhere('review.status = :status', { status }) : qb,
    );
  }

  /** The admin queue: every merchant, both modes. */
  async listAll(
    query: ResolvedListQuery,
    filters: { status?: ReviewStatus; merchantId?: MerchantId },
  ): Promise<Paginated<ReviewEntity>> {
    let qb = this.createQueryBuilder('review');
    if (filters.status) qb = qb.andWhere('review.status = :status', { status: filters.status });
    if (filters.merchantId) qb = qb.andWhere('review.merchant_id = :merchantId', { merchantId: filters.merchantId });
    const rows = await applyCursor(qb, { limit: query.limit, cursor: query.cursor, alias: 'review' }).getMany();
    return toPage(rows, query.limit);
  }

  findById(id: string): Promise<ReviewEntity | null> {
    return this.findOne({ where: { id } });
  }

  /** `open → approved | declined`. Returns rows affected; 0 = somebody else decided first. */
  async close(
    manager: EntityManager,
    id: string,
    decision: { status: Exclude<ReviewStatus, 'open'>; closedAt: Date; closedBy: StaffUserId | null; note: string | null },
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ReviewEntity)
      .set(decision)
      .where('id = :id AND status = :open', { id, open: 'open' })
      .execute();
    return result.affected ?? 0;
  }
}
