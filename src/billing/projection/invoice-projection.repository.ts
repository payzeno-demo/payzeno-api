/**
 * L1 for `invoice_projection`.
 *
 * `upsertIfNewer` is the whole point of this class: an unconditional upsert would let a
 * redelivered older `invoice.issued` overwrite a newer row, and the bus is explicitly
 * unordered and at-least-once. The guard is in the SQL, not in a read-then-write, for the same
 * reason ADR 0011 gives — a dedupe guard around a side effect is one atomic write or it is
 * nothing.
 */

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, type FindOptionsWhere } from 'typeorm';
import type { InvoiceStatus, MerchantId, Paginated } from '@payzeno/contracts';

import { resolveListQuery } from '../../common/pagination/list-query.dto';
import { applyCursor, toPage } from '../../common/persistence/cursor';
import { PayzenoRepository } from '../../common/persistence/payzeno.repository';
import { InvoiceProjectionEntity } from './invoice-projection.entity';

export interface InvoiceProjectionQuery {
  status?: InvoiceStatus;
  cursor?: string;
  limit?: number;
}

@Injectable()
export class InvoiceProjectionRepository extends PayzenoRepository<InvoiceProjectionEntity> {
  constructor(dataSource: DataSource) {
    super(InvoiceProjectionEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'invoice_projection';
  }

  /**
   * Keyset page over `(created_at, id)` — the one ordering `cursor.ts` and the cursor codec
   * speak. Not `paginateCursor`: this table has no `livemode` column on the entity, so the
   * scoped builder's mode predicate has nothing to bind to.
   */
  async listForMerchant(
    merchantId: MerchantId,
    query: InvoiceProjectionQuery,
  ): Promise<Paginated<InvoiceProjectionEntity>> {
    const { limit, cursor } = resolveListQuery(query);
    let qb = this.createQueryBuilder(this.alias).where(`${this.alias}.merchant_id = :merchantId`, {
      merchantId,
    });
    if (query.status) {
      qb = qb.andWhere(`${this.alias}.status = :status`, { status: query.status });
    }
    const rows = await applyCursor(qb, { limit, cursor, alias: this.alias }).getMany();
    return toPage(rows, limit);
  }

  findByIdForMerchant(merchantId: MerchantId, invoiceId: string): Promise<InvoiceProjectionEntity | null> {
    return this.findOne({
      where: { id: invoiceId, merchant_id: merchantId } as FindOptionsWhere<InvoiceProjectionEntity>,
    });
  }

  /** True when the merchant has any projected invoice at all — the cache-hit predicate. */
  async hasRowsFor(merchantId: MerchantId): Promise<boolean> {
    const count = await this.count({
      where: { merchant_id: merchantId } as FindOptionsWhere<InvoiceProjectionEntity>,
    });
    return count > 0;
  }

  /**
   * Conditional upsert. Returns true when the row was written, false when an existing row was
   * already at or ahead of `source_occurred_at`.
   *
   * Two statements, because TypeORM's `orUpdate` has no way to put a WHERE on its DO UPDATE
   * arm. Each is a single guarded write and neither reads first: an insert that does nothing
   * on conflict, then an update whose WHERE carries the ordering guard. Columns absent from
   * `row` are left alone on the update — an `invoice.issued` carries no lines, and must not
   * blank the ones a legacy cache fill wrote.
   */
  async upsertIfNewer(
    row: Partial<InvoiceProjectionEntity> & { id: string; source_occurred_at: Date },
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(InvoiceProjectionEntity) : this;
    const inserted = await repo
      .createQueryBuilder()
      .insert()
      .into(InvoiceProjectionEntity)
      .values(row)
      .orIgnore()
      .returning('id')
      .execute();
    if ((inserted.raw as unknown[]).length > 0) {
      return true;
    }

    const { id, ...columns } = row;
    const updated = await repo
      .createQueryBuilder()
      .update(InvoiceProjectionEntity)
      .set(columns)
      .where('id = :id', { id })
      .andWhere('source_occurred_at < :incomingOccurredAt', {
        incomingOccurredAt: row.source_occurred_at,
      })
      .execute();
    return (updated.affected ?? 0) > 0;
  }

  /** Used by the invoice void path so the cache does not serve a voided invoice as `open`. */
  async markStatus(invoiceId: string, status: InvoiceStatus, refreshedAt: Date): Promise<void> {
    await this.createQueryBuilder()
      .update(InvoiceProjectionEntity)
      .set({ status, refreshed_at: refreshedAt })
      .where('id = :id', { id: invoiceId })
      .execute();
  }
}
