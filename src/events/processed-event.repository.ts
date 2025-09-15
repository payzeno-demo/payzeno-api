import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, LessThan } from 'typeorm';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { PROCESSED_EVENT_RETENTION_DAYS, ProcessedEvent } from './processed-event.entity';

/**
 * The dedupe table. One method matters — `claim` — and it is the reason ADR 0011 exists.
 */
@Injectable()
export class ProcessedEventRepository extends PayzenoRepository<ProcessedEvent> {
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
  async release(eventId: string, consumer: string): Promise<void> {
    await this.manager.delete(ProcessedEvent, { eventId, consumer });
  }

  retentionCutoff(now: Date): Date {
    return new Date(now.getTime() - PROCESSED_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }
}
