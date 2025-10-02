import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { MerchantId, PublicEventType, WebhookEventStatus } from '@payzeno/contracts';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { WebhookEventEntity } from './webhook-event.entity';

@Injectable()
export class WebhookEventRepository extends PayzenoRepository<WebhookEventEntity> {
  constructor(dataSource: DataSource) {
    super(WebhookEventEntity, dataSource.createEntityManager());
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
      .values(rows as WebhookEventEntity[])
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
