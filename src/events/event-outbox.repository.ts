import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { EventOutbox } from './event-outbox.entity';
import { nextOutboxAttemptAt, OUTBOX_MAX_ATTEMPTS } from './publisher.types';

/**
 * Persistence for `event_outbox`. Everything the drain does that is not a network call
 * lives here — the claim query in particular, because getting it wrong is how you publish
 * every event N times where N is the task count.
 */
@Injectable()
export class EventOutboxRepository extends PayzenoRepository<EventOutbox> {
  constructor(dataSource: DataSource) {
    super(EventOutbox, dataSource.createEntityManager());
  }

  /**
   * Enqueue inside the caller's transaction. `tx` is the business transaction's
   * EntityManager — that is the whole point of the outbox and the reason this method takes
   * one instead of using `this.manager`.
   */
  async enqueue(tx: EntityManager, row: EventOutbox): Promise<string> {
    await tx.insert(EventOutbox, row);
    return row.id;
  }

  /**
   * The drain query, verbatim from data-model.md §1.11.
   *
   * `FOR UPDATE SKIP LOCKED` is load-bearing: `OutboxDrainJob` runs every 5s in ALL tasks,
   * so an unclaimed `WHERE published_at IS NULL` select publishes every event once per
   * task. The `next_attempt_at <= now()` predicate is what keeps a permanently failing row
   * from being re-selected every 5 seconds forever.
   */
}
