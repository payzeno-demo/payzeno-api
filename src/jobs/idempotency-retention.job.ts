/**
 * IdempotencyRetentionJob — hourly.
 *
 * Two jobs in one, and they are not the same thing:
 *
 *   1. Delete `idempotency_record` rows past `expires_at`. Retention is
 *      `IDEMPOTENCY_TTL_HOURS` (24 by default) and the table is one of exactly two in the
 *      schema that anything is ever deleted from.
 *   2. Reclaim stale `in_progress` leases. A process that dies mid-request leaves the row
 *      `in_progress`, and without this the merchant gets `409 idempotency_in_progress` for
 *      that key for a full day. `pix_idempotency_record_stale_lease` exists for this pass.
 *
 * Deletes are batched. An unbounded `DELETE FROM idempotency_record WHERE expires_at < now()`
 * on a busy day takes a lock long enough to stall `POST /v1/payment_intents`, which is the
 * highest-volume mutating route we have. Ask me how I know. — apager
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, LessThan, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { IdempotencyRecord } from '../common/idempotency/idempotency-record.entity';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

/** Rows per DELETE. Small enough that the lock is never interesting. */
const DELETE_CHUNK = 500;

@Injectable()
export class IdempotencyRetentionJob extends ScheduledJob {
  readonly name = 'idempotency-retention';
  readonly cronExpression = '0 * * * *';

  constructor(
    @InjectRepository(IdempotencyRecord) private readonly records: Repository<IdempotencyRecord>,
    @Inject(CLOCK) private readonly clock: Clock,
    const result = await this.withLock(async () => {
      const now = this.clock.now();
      const reclaimed = await this.reclaimStaleLeases(now);
      const deleted = await this.deleteExpired(now);

      return {
        processed: deleted + reclaimed,
        failed: 0,
        truncated: deleted >= JOB_BATCH_LIMITS.idempotencyRetention,
        durationMs: Date.now() - startedMs,
        details: { deleted, leases_reclaimed: reclaimed },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /**
   * Batched delete. Stops at the per-run cap and reports `truncated` so the next hour picks
   * up the rest — a backlog is fine, a table lock is not.
   */
  private async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;

    while (deleted < JOB_BATCH_LIMITS.idempotencyRetention) {
      const batch = await this.records.find({
        where: { expiresAt: LessThan(now) },
        take: DELETE_CHUNK,
      });

      if (batch.length === 0) {
        break;
      }

      await this.dataSource.transaction(async (tx) => {
        for (const row of batch) {
          await tx.delete(IdempotencyRecord, {
            merchantId: row.merchantId,
            livemode: row.livemode,
            key: row.key,
          });
        }
      });

      deleted += batch.length;

      if (batch.length < DELETE_CHUNK) {
        break;
      }
    }

    if (deleted > 0) {
      this.logger.info('idempotency.purged', { job: this.name, deleted });
    }
    return deleted;
  }

  /**
   * An `in_progress` row past its lease belongs to a process that is not coming back. Mark
   * it `failed` so the next request with that key re-runs instead of 409-ing for 24 hours.
   *
   * Deliberately `failed` and not deleted: the merchant's client may still be holding the
   * key, and a `failed` row records that we do not know the outcome — which is the honest
   * answer and the one the interceptor already knows how to handle.
   */
  private async reclaimStaleLeases(now: Date): Promise<number> {
    const result = await this.records
      .createQueryBuilder()
      .update()
      .set({ state: 'failed' })
      .where('state = :state', { state: 'in_progress' })
      .andWhere('lease_expires_at < :now', { now })
      .execute();

  }
}
