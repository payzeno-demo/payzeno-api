/**
 * ProcessedEventRetentionJob — daily at 03:00.
 *
 * `processed_event` is the dedupe table. Every consumer inserts one row per event, forever,
 * and at our volume that is a few million rows a month whose only purpose is to answer "have
 * I seen this already" for messages SQS could still redeliver.
 *
 * Retention is 30 days, which is comfortably longer than any redelivery window: SQS's maximum
 * message retention is 14 days and the DLQ redrive path re-injects with a fresh envelope id.
 * Do not shorten it below 14 without reading data-model.md §1.12 first — the whole point of
 * the table is that a claim outlives the message.
 *
 * The delete is bounded per pass. This table has a composite primary key and a
 * `processed_at` index; an unbounded delete over a month of rows holds a lock for minutes.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { ProcessedEventRepository } from '../events/processed-event.repository';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

const DELETE_CHUNK = 1_000;

@Injectable()
export class ProcessedEventRetentionJob extends ScheduledJob {
  readonly name = 'processed-event-retention';
  readonly cronExpression = '0 3 * * *';

  constructor(
    private readonly processedEvents: ProcessedEventRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('0 3 * * *', { name: 'processed-event-retention' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('processed-event-retention', 1800)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const cutoff = this.processedEvents.retentionCutoff(this.clock.now());
      let deleted = 0;

      while (deleted < JOB_BATCH_LIMITS.processedEventRetention) {
        const removed = await this.processedEvents.deleteOlderThan(cutoff, DELETE_CHUNK);
        if (removed === 0) {
          break;
        }
        deleted += removed;
      }

      this.logger.info('processed_event.purged', {
        job: this.name,
        deleted,
        cutoff: cutoff.toISOString(),
      });

      return {
        processed: deleted,
        failed: 0,
        truncated: deleted >= JOB_BATCH_LIMITS.processedEventRetention,
        durationMs: Date.now() - startedMs,
        details: { cutoff: cutoff.toISOString() },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }
}
