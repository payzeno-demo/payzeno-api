import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_SCHEMA_VERSIONS,
  type EventType,
  type PayloadOfType,
  type PayzenoEvent,
} from '@payzeno/contracts/events';
import { CLOCK, type Clock } from '../common/time/clock';
import { IdFactory } from '../common/ids/id.factory';
import { ApiIdPrefix } from '../common/ids/id.prefix';
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
    const row = new EventOutbox();
    row.id = this.ids.generate(ApiIdPrefix.EVENT);
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
