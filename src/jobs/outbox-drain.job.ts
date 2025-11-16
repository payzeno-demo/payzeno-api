/**
 * OutboxDrainJob — every 5 seconds, in every task.
 *
 * The outbox is the only propagation path payzeno-api has. `OutboxEventPublisher` writes the
 * row inside the business transaction; this job is what turns it into an SNS message. If it
 * stops, the ledger stops hearing about authorisations and nobody notices for an hour —
 * which is why `payzeno-api-outbox-pending` is a page and not a dashboard.
 *
 * Two things keep this correct under three tasks:
 *   - `claimDue` selects `FOR UPDATE SKIP LOCKED`, so two tasks never take the same row;
 *   - the Redis lease means only one task is normally draining at all.
 * Both, not either. The lease can lapse; SKIP LOCKED cannot.
 *
 * On failure the row is NOT deleted and NOT retried in-line: `markFailed` pushes
 * `next_attempt_at` out exponentially and tombstones at attempt 12. docs/runbooks/payzeno-api.md
 * has the redrive procedure for the dead ones.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import type { PayzenoEvent } from '@payzeno/contracts/events';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { EventOutboxRepository } from '../events/event-outbox.repository';
import type { EventOutbox } from '../events/event-outbox.entity';
import { BUS_PUBLISHER, type EventPublisher } from '../events/publisher';
import type { DrainOutcome } from '../events/publisher.types';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

/** Task identity written to `claimed_by`. Diagnostic only — SKIP LOCKED is the actual lock. */
const TASK_ID = `${process.pid}`;

@Injectable()
export class OutboxDrainJob extends ScheduledJob {
  readonly name = 'outbox-drain';
  readonly cronExpression = '*/5 * * * * *';

  constructor(
    private readonly outbox: EventOutboxRepository,
    @Inject(BUS_PUBLISHER) private readonly bus: EventPublisher,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('*/5 * * * * *', { name: 'outbox-drain' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('outbox-drain', 30)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const outcome = await this.withLock(async () => this.drain());
    if (!outcome) {
      return this.skipped();
    }

    return {
      processed: outcome.published,
      failed: outcome.failed,
      truncated: outcome.claimed >= JOB_BATCH_LIMITS.outboxDrain,
      durationMs: Date.now() - startedMs,
      details: { claimed: outcome.claimed, dead: outcome.dead },
    };
  }

  /**
   * One pass. Published in a batch because SNS charges per request and a 200-row drain is
   * twenty calls instead of two hundred; failed individually because one bad payload must
   * not poison the other 199.
   */
  private async drain(): Promise<DrainOutcome> {
    const rows = await this.outbox.claimDue(JOB_BATCH_LIMITS.outboxDrain, TASK_ID);

    if (rows.length === 0) {
      return { claimed: 0, published: 0, failed: 0, dead: 0 };
    }

    try {
      const ids = await this.bus.publishBatch(rows.map(toEnvelope));
      await this.outbox.markPublished(ids, new Date());

      return { claimed: rows.length, published: ids.length, failed: 0, dead: 0 };
    } catch (err) {
      return this.retryIndividually(rows, err);
    }
  }

  /**
   * The batch failed, so we do not know which entry SNS objected to. Republish one at a
   * time: an oversized payload or an unknown topic is a property of one row, and giving up
   * on the whole page for it is how a single malformed event stalls the bus.
   */
  private async retryIndividually(rows: EventOutbox[], batchError: unknown): Promise<DrainOutcome> {
    this.logger.warn('outbox.batch_failed', {
      job: this.name,
      rows: rows.length,
      error: batchError instanceof Error ? batchError.message : String(batchError),
    });

    const outcome: DrainOutcome = { claimed: rows.length, published: 0, failed: 0, dead: 0 };
    const now = new Date();

    for (const row of rows) {
      try {
        await this.bus.publishBatch([toEnvelope(row)]);
        await this.outbox.markPublished([row.id], now);
        outcome.published += 1;
      } catch (err) {
        const state = await this.outbox.markFailed(
          row.id,
          err instanceof Error ? err.message : String(err),
          now,
        );
        outcome.failed += 1;

        if (state === 'dead') {
          outcome.dead += 1;
          // Twelve attempts over roughly an hour. Somebody has to look at this one.
          this.logger.error('outbox.event_dead', err, {
            event_id: row.id,
            type: row.type,
            attempt_count: row.attemptCount + 1,
          });
        }
      }
    }

    return outcome;
  }
}

/**
 * The drain republishes exactly what the business transaction committed. It does not
 * re-derive the envelope: `version` was stamped from `EVENT_SCHEMA_VERSIONS` at publish time
 * and re-deriving it here would silently upgrade an event that was written before a bump.
 */
function toEnvelope(row: EventOutbox): PayzenoEvent {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    occurred_at: row.occurredAt.toISOString(),
    source: 'payzeno-api',
    correlation_id: row.correlationId,
    causation_id: row.causationId,
    merchant_id: row.merchantId,
    livemode: row.livemode,
    payload: row.payload,
  } as unknown as PayzenoEvent;
}
