import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_SCHEMA_VERSIONS,
  type EventType,
  type PayloadOfType,
  type PayzenoEvent,
} from '@payzeno/contracts/events';
import { CLOCK, type Clock } from '../common/time/clock';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { EventOutbox } from './event-outbox.entity';
import { EventOutboxRepository } from './event-outbox.repository';
import { type EventPublisher, isApiOwnedEvent } from './publisher';
import type { PublishContext } from './publisher.types';

/**
 * The production publisher. Writes `event_outbox` inside the caller's transaction; a poller
 * (`OutboxDrainJob`) drains it into `SnsEventPublisher`.
 *
 * This is the only publisher a business service is allowed to inject, and the reason is
 * boring and absolute: a direct SNS publish either fires for a transaction that later rolls
 * back, or fails for one that already committed. Both have happened here. See
 * docs/adr/0011-outbox-over-direct-publish.md.
 *
 * The transaction it writes into is the AMBIENT one — `TransactionManager.currentManager()`
 * — so `publish()` keeps the `EventPublisher` signature and callers do not have to thread an
 * EntityManager through four frames. Outside a transaction it falls back to autocommit,
 * which is correct for the handful of non-transactional emitters (RiskEvaluationJob).
 */
@Injectable()
export class OutboxEventPublisher implements EventPublisher {
  constructor(
    private readonly outbox: EventOutboxRepository,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async publish<T extends EventType>(
    type: T,
    payload: PayloadOfType<T>,
    ctx: PublishContext,
  ): Promise<string> {
    if (!isApiOwnedEvent(type)) {
      // A service trying to publish settlement.* or ledger.* has misunderstood ownership.
      // The ledger owns those and would consume its own event straight back off the topic.
      throw new Error(`payzeno-api does not own event type "${type}"`);
    }

    const row = this.toRow(type, payload, ctx);
    const tx = this.transactions.currentManager();
    await this.outbox.enqueue(tx, row);

    this.logger.debug('outbox.enqueued', {
      event_id: row.id,
      type,
      merchant_id: row.merchantId,
      livemode: row.livemode,
      in_transaction: this.transactions.isInTransaction(),
    });
    return row.id;
  }

  /**
   * Bulk enqueue for the few callers that emit a fixed set at once —
   * `MerchantOnboardingService` writes `merchant.created` alongside the bootstrap call, and
   * `DisputeDeadlineReminderJob` expires a whole page of disputes in one transaction.
   */
  async publishBatch(events: ReadonlyArray<PayzenoEvent>): Promise<string[]> {
    const tx = this.transactions.currentManager();
    const ids: string[] = [];

    for (const event of events) {
      if (!isApiOwnedEvent(event.type)) {
        throw new Error(`payzeno-api does not own event type "${event.type}"`);
      }
      const row = new EventOutbox();
      row.id = event.id || this.ids.webhookEventId();
      row.type = event.type;
      row.version = event.version || EVENT_SCHEMA_VERSIONS[event.type];
      row.payload = event.payload as unknown as Record<string, unknown>;
      row.merchantId = event.merchant_id;
      row.correlationId = event.correlation_id;
      row.causationId = event.causation_id;
      row.livemode = event.livemode;
      row.occurredAt = new Date(event.occurred_at);
      row.attemptCount = 0;
      row.nextAttemptAt = this.clock.now();
      row.createdAt = this.clock.now();

      await this.outbox.enqueue(tx, row);
      ids.push(row.id);
    }

    this.logger.info('outbox.enqueued_batch', { count: ids.length });
    return ids;
  }

  private toRow<T extends EventType>(
    type: T,
    payload: PayloadOfType<T>,
    ctx: PublishContext,
  ): EventOutbox {
    const now = this.clock.now();
    const row = new EventOutbox();
    row.id = this.ids.webhookEventId();
    row.type = type;
    row.version = EVENT_SCHEMA_VERSIONS[type];
    row.payload = payload as unknown as Record<string, unknown>;
    row.merchantId = ctx.merchantId;
    row.correlationId = ctx.correlationId;
    row.causationId = ctx.causationId;
    row.livemode = ctx.livemode;
    row.occurredAt = ctx.occurredAt ? new Date(ctx.occurredAt) : now;
    row.publishedAt = null;
    row.attemptCount = 0;
    row.nextAttemptAt = now;
    row.claimedAt = null;
    row.claimedBy = null;
    row.deadAt = null;
    row.lastError = null;
    row.createdAt = now;
    return row;
  }
}
