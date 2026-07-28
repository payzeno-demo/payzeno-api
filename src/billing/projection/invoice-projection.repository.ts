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

  async listForMerchant(
    merchantId: MerchantId,
    query: InvoiceProjectionQuery,
  ): Promise<Paginated<InvoiceProjectionEntity>> {
    const where: FindOptionsWhere<InvoiceProjectionEntity> = {
      merchant_id: merchantId,
    } as FindOptionsWhere<InvoiceProjectionEntity>;
    if (query.status) {
      (where as Record<string, unknown>).status = query.status;
    }
    return this.paginateCursor(
      { cursor: query.cursor, limit: query.limit },
      where,
      { column: 'period_start', direction: 'DESC' },
    );
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
   */
  async upsertIfNewer(
    row: Partial<InvoiceProjectionEntity> & { id: string; source_occurred_at: Date },
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(InvoiceProjectionEntity) : this;
    const result = await repo
      .createQueryBuilder()
      .insert()
      .into(InvoiceProjectionEntity)
      .values(row)
      .orUpdate(
        [
          'merchant_id',
          'subscription_id',
          'number',
          'status',
          'currency',
          'subtotal_minor',
          'tax_minor',
          'total_minor',
          'amount_paid_minor',
          'lines',
          'period_start',
          'period_end',
          'due_at',
          'migrated_to_ledger',
          'source_occurred_at',
          'source',
          'refreshed_at',
        ],
        ['id'],
        { skipUpdateIfNoValuesChanged: true },
      )
      .setParameter('incoming_occurred_at', row.source_occurred_at)
      .where('invoice_projection.source_occurred_at < :incoming_occurred_at')
      .execute();
    return (result.raw as unknown[]).length > 0;
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
