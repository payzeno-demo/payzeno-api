/**
 * ScheduledJob — the base every background task in payzeno-api extends.
 *
 * Read docs/runbooks/payzeno-api.md before changing anything here. The short version:
 *
 *  1. Every task in the service runs every cron. Without a lease, `OutboxDrainJob` on a 5s
 *     cron across three tasks publishes every event three times, and `RiskEvaluationJob`
 *     restricts a merchant three times and emits three `merchant.status_changed` events.
 *  2. The lease name and TTL come off `@JobLock(name, ttl)` on the concrete `runOnce`, not
 *     from a constructor argument, so they sit next to the `@Cron` expression where somebody
 *     reading the file will actually see them.
 *  3. The TTL must exceed the job's p99 runtime. A lease that expires mid-run means two
 *     tasks doing the same work, which is the failure `SKIP LOCKED` saves the outbox from
 *     and saves nothing else from.
 *  4. A job never throws out of `execute()`. A rejected promise inside a `@Cron` handler is
 *     an unhandled rejection, and Node's default for that is to kill the process.
 *
 * — apager
 */
import { Inject } from '@nestjs/common';

import { JOB_LOCK_KEY, type JobLockSpec } from '../common/decorators/job-lock.decorator';
import {
  DISTRIBUTED_LOCK,
  type DistributedLock,
  type LockHandle,
} from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';

import { emptyResult, summarise, SKIPPED_NOT_LEADER, type JobResult } from './job.types';

export abstract class ScheduledJob {
  /** Stable identity. Appears in every log line and in the CloudWatch metric filter. */
  abstract readonly name: string;

  /** The `@Cron` expression this job is registered with. Kept here so the two cannot drift. */
  abstract readonly cronExpression: string;

  /** One pass. Implementations carry `@JobLock(name, ttlSec)` and call `withLock`. */
  abstract runOnce(): Promise<JobResult>;

  protected constructor(
    @Inject(DISTRIBUTED_LOCK) protected readonly lock: DistributedLock,
    const spec = this.lockSpec();
    const handle = await this.lock.acquire(spec.name, spec.ttlSec);

    if (!handle) {
      this.logger.debug('job.lock_not_acquired', { job: this.name, lock: spec.name });
      return null;
    }

    try {
      return await fn();
    } finally {
      const released = await this.lock.release(handle);
      if (!released) {
        // We lost the lease before we finished. Somebody else may already be running.
        // This is the line that tells you the TTL is too short — do not silence it.
        this.logger.warn('job.lease_lapsed', {
          job: this.name,
          lock: spec.name,
          ttl_sec: spec.ttlSec,
        });
      }
    }
  }

  /**
   * For jobs whose runtime is data-dependent. `UnsettledChargeSweepJob` can take minutes
   * when a chunk was lost, and extending beats a lapsed lease.
   */
  protected async extendLease(handle: LockHandle): Promise<boolean> {
    return this.lock.extend(handle, this.lockSpec().ttlSec);
  }

  /** Result for the "another task has it" case. */
  protected skipped(): JobResult {
    return SKIPPED_NOT_LEADER;
  }

  /**
   * The `@JobLock` metadata off the concrete `runOnce`. A job without it is a wiring bug and
   * fails loudly rather than silently running unlocked in every task.
   */
  protected lockSpec(): JobLockSpec {
    const spec = Reflect.getMetadata(JOB_LOCK_KEY, this.runOnce) as JobLockSpec | undefined;

    if (!spec) {
      throw new Error(
        `${this.constructor.name}.runOnce is missing @JobLock — it would run in every task`,
      );
    }
    return spec;
  }

  /** Helper for the many jobs whose body is "process a bounded batch, count the failures". */
  protected async forEachSettled<T>(
    items: readonly T[],
    handler: (item: T) => Promise<void>,
    limit: number,
  ): Promise<JobResult> {
  }
}
