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
import { JOB_LOCK_KEY, type JobLockSpec } from '../common/decorators/job-lock.decorator';
import type { DistributedLock, LockHandle } from '../common/lock/distributed-lock';
import type { PayzenoLogger } from '../common/logging/logger';

import { emptyResult, summarise, SKIPPED_NOT_LEADER, type JobResult } from './job.types';

export abstract class ScheduledJob {
  /** Stable identity. Appears in every log line and in the CloudWatch metric filter. */
  abstract readonly name: string;

  /** The `@Cron` expression this job is registered with. Kept here so the two cannot drift. */
  abstract readonly cronExpression: string;

  /** One pass. Implementations carry `@JobLock(name, ttlSec)` and call `withLock`. */
  abstract runOnce(): Promise<JobResult>;

  /**
   * No `@Inject` here — each concrete job injects the lock and the logger and passes them up.
   * Parameter `@Inject`s on a base class are inherited by index: they made every job's FIRST
   * constructor argument the distributed lock, whatever the job actually asked for there.
   */
  protected constructor(
    protected readonly lock: DistributedLock,
    protected readonly logger: PayzenoLogger,
  ) {}

  /**
   * The entry point Nest's scheduler calls. Never rejects: a job that throws takes the
   * process with it, and a payments API that restarts every five seconds because the dispute
   * reminder cannot reach Postgres is a worse outage than a missing reminder.
   */
  async execute(): Promise<JobResult> {
    const startedMs = Date.now();

    try {
      const result = await this.runOnce();
      this.logger.info('job.finished', { job: this.name, ...summarise(result) });
      return result;
    } catch (err) {
      this.logger.error('job.failed', err, {
        job: this.name,
        duration_ms: Date.now() - startedMs,
      });
      return { ...emptyResult(Date.now() - startedMs), failed: 1 };
    }
  }

  /**
   * Runs `fn` only if this task wins the lease. Returns null when it does not — the caller
   * turns that into `SKIPPED_NOT_LEADER` so a dashboard can tell "somebody else has it" from
   * "there was nothing to do".
   */
  protected async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
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
    const startedMs = Date.now();
    let failed = 0;

    for (const item of items) {
      try {
        await handler(item);
      } catch (err) {
        failed += 1;
        this.logger.error('job.item_failed', err, { job: this.name });
      }
    }

    return {
      processed: items.length,
      failed,
      truncated: items.length >= limit,
      durationMs: Date.now() - startedMs,
    };
  }
}
