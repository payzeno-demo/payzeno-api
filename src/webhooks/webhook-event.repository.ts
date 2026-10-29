import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { MerchantId, PublicEventType, WebhookEventStatus } from '@payzeno/contracts';
import { PayzenoRepository, toInsertRows } from '../common/persistence/payzeno.repository';
import { WebhookEventEntity } from './webhook-event.entity';

@Injectable()
export class WebhookEventRepository extends PayzenoRepository<WebhookEventEntity> {
  constructor(dataSource: DataSource) {
    super(WebhookEventEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'webhook_event';
  }

  /**
   * The only insert path for this table, called from `WebhookFanoutConsumer` inside the
   * claim transaction.
   *
   * ON CONFLICT DO NOTHING against `uq_webhook_event_source (endpoint_id, source_event_id)`.
   * The bus is at-least-once: without this key a redelivered `payout.failed` sends the
   * merchant a second webhook, and merchants build accounting on these.
   *
   * Returns the number of rows that were actually new.
   */
  async insertIgnoringSourceConflict(
    tx: EntityManager,
    rows: readonly WebhookEventEntity[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const result = await tx
      .createQueryBuilder()
      .insert()
      .into(WebhookEventEntity)
      .values(toInsertRows(rows))
      .orIgnore('ON CONSTRAINT uq_webhook_event_source')
      .returning('id')
      .execute();

    return Array.isArray(result.raw) ? result.raw.length : 0;
  }

  /**
   * `pix_webhook_event_due` — the partial index the delivery job rides. Rows are claimed
   * with SKIP LOCKED because the job runs in every task, exactly like the outbox drain.
   */
  async claimDue(limit: number, now: Date): Promise<WebhookEventEntity[]> {
    return this.manager.transaction(async (tx) => {
      const due = await tx
        .createQueryBuilder(WebhookEventEntity, 'w')
        .where("w.status = 'pending'")
        .andWhere('w.next_attempt_at is not null')
        .andWhere('w.next_attempt_at <= :now', { now })
        .orderBy('w.next_attempt_at', 'ASC')
        .limit(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (due.length === 0) {
        return [];
      }

      await tx.update(
        WebhookEventEntity,
        { id: In(due.map((row) => row.id)) },
        { status: 'delivering' as WebhookEventStatus },
      );
      return due;
    });
  }

  async markDelivered(id: string, responseStatus: number, at: Date): Promise<void> {
    await this.update({ id } as never, {
      status: 'delivered' as WebhookEventStatus,
      lastResponseStatus: responseStatus,
      lastError: null,
      deliveredAt: at,
      nextAttemptAt: null,
    });
  }

  async markRetrying(
    id: string,
    attemptCount: number,
    nextAttemptAt: Date,
    responseStatus: number | null,
    error: string | null,
  ): Promise<void> {
    await this.update({ id } as never, {
      status: 'pending' as WebhookEventStatus,
      attemptCount,
      nextAttemptAt,
      lastResponseStatus: responseStatus,
      lastError: error?.slice(0, 2000) ?? null,
    });
  }

  async markDead(
    id: string,
    attemptCount: number,
    responseStatus: number | null,
    error: string | null,
  ): Promise<void> {
    await this.update({ id } as never, {
      status: 'dead' as WebhookEventStatus,
      attemptCount,
      nextAttemptAt: null,
      lastResponseStatus: responseStatus,
      lastError: error?.slice(0, 2000) ?? null,
    });
  }

  /** Console list, `ix_webhook_event_merchant_created`. */
  async listForMerchant(
    merchantId: MerchantId,
    filters: { status?: WebhookEventStatus; type?: PublicEventType },
    limit: number,
  ): Promise<WebhookEventEntity[]> {
    const qb = this.createQueryBuilder('w')
      .where('w.merchant_id = :merchantId', { merchantId })
      .orderBy('w.created_at', 'DESC')
      .limit(limit);

    if (filters.status) {
      qb.andWhere('w.status = :status', { status: filters.status });
    }
    if (filters.type) {
      qb.andWhere('w.type = :type', { type: filters.type });
    }
    return qb.getMany();
  }

  async countDead(merchantId: MerchantId, endpointId: string): Promise<number> {
    return this.count({
      where: { merchantId, endpointId, status: 'dead' as WebhookEventStatus },
    } as never);
  }
}
