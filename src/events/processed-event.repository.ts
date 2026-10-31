import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { PROCESSED_EVENT_RETENTION_DAYS, ProcessedEvent } from './processed-event.entity';

/**
 * The dedupe table. One method matters — `claim` — and it is the reason ADR 0011 exists.
 *
 * A plain `Repository`, not a `PayzenoRepository`: the key is `(event_id, consumer)`, there is
 * no tenant and no `created_at`, so there is nothing to scope or to page by.
 */
@Injectable()
export class ProcessedEventRepository extends Repository<ProcessedEvent> {
  constructor(dataSource: DataSource) {
    super(ProcessedEvent, dataSource.createEntityManager());
  }

  /**
   * INSERT-FIRST claim, in the caller's transaction:
   *
   *   INSERT INTO processed_event (event_id, consumer)
   *   VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id
   *
   * Returns true when this call won the row and the handler should run; false when the
   * event was already processed by this consumer and the handler must be skipped entirely.
   *
   * There is deliberately no `alreadyProcessed()` / `markProcessed()` pair. Check-then-act
   * is the exact shape of PAY-2041 — two workers both read "not processed", both settle,
   * and the merchant is charged twice. Do not add one back.
   */
  async claim(tx: EntityManager, eventId: string, consumer: string): Promise<boolean> {
    const inserted: Array<{ event_id: string }> = await tx.query(
      `insert into processed_event (event_id, consumer)
       values ($1, $2)
       on conflict (event_id, consumer) do nothing
       returning event_id`,
      [eventId, consumer],
    );
    return inserted.length === 1;
  }

  /**
   * Release a claim. Called only when the handler threw *after* the claim but the
   * transaction could not be rolled back cleanly — in practice the rollback does this for
   * us, and this exists for the DLQ redrive path where the claim is committed separately.
   */
  async release(eventId: string, consumer: string): Promise<void> {
    await this.manager.delete(ProcessedEvent, { eventId, consumer });
  }

  async wasProcessed(eventId: string, consumer: string): Promise<boolean> {
    const count = await this.manager.count(ProcessedEvent, {
      where: { eventId, consumer },
    });
    return count > 0;
  }

  /** `ProcessedEventRetentionJob`, daily at 03:00. Bounded so it cannot lock the table. */
  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    const stale = await this.manager.find(ProcessedEvent, {
      where: { processedAt: LessThan(cutoff) },
      take: batchSize,
    });
    if (stale.length === 0) {
      return 0;
    }
    await this.manager.remove(stale);
    return stale.length;
  }

  retentionCutoff(now: Date): Date {
    return new Date(now.getTime() - PROCESSED_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }
}
