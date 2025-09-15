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
    const row = this.toRow(type, payload, ctx);
  }
}
