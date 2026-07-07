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
  async claimDue(limit: number, claimedBy: string): Promise<EventOutbox[]> {
    return this.manager.transaction(async (tx) => {
      const due: EventOutbox[] = await tx
        .createQueryBuilder(EventOutbox, 'e')
        .where('e.published_at is null')
        .andWhere('e.dead_at is null')
        .andWhere('e.next_attempt_at <= now()')
        .orderBy('e.occurred_at', 'ASC')
        .limit(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (due.length === 0) {
        return [];
      }

      await tx.update(
        EventOutbox,
        { id: In(due.map((row) => row.id)) },
        { claimedAt: new Date(), claimedBy },
      );
      return due;
    });
  }

  /** Terminal success. A published row is never re-selected. */
  async markPublished(ids: readonly string[], publishedAt: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.manager.update(
      EventOutbox,
      { id: In([...ids]) },
      { publishedAt, lastError: null },
    );
    return result.affected ?? 0;
  }

  /**
   * Failure path: bump the attempt, push `next_attempt_at` out exponentially, and tombstone
   * at attempt 12. `dead_at` is what stops the drain; nothing deletes these rows, because
   * the postmortem after PAY-2041 wanted the evidence to still be there.
   */
  async markFailed(id: string, error: string, now: Date): Promise<'retrying' | 'dead'> {
    const row = await this.manager.findOneByOrFail(EventOutbox, { id });
    const attemptCount = row.attemptCount + 1;
    const dead = attemptCount >= OUTBOX_MAX_ATTEMPTS;

    await this.manager.update(
      EventOutbox,
      { id },
      {
        attemptCount,
        lastError: error.slice(0, 2000),
        nextAttemptAt: nextOutboxAttemptAt(now, attemptCount),
        claimedAt: null,
        claimedBy: null,
        deadAt: dead ? now : null,
      },
    );
    return dead ? 'dead' : 'retrying';
  }

  /** Rows the drain gave up on. Alarmed on by the infra `payzeno-api-outbox-dead` metric. */
  async deadCount(): Promise<number> {
    return this.manager
      .createQueryBuilder(EventOutbox, 'e')
      .where('e.dead_at is not null')
      .getCount();
  }
}
