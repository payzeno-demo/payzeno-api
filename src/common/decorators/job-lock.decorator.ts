/**
 * `@JobLock('outbox-drain', 30)` — declares the distributed lease a ScheduledJob takes.
 *
 * All nine `ScheduledJob.runOnce` implementations carry it. `ScheduledJob.withLock` reads the
 * metadata off the concrete class, so the lease name and TTL live next to the cron
 * expression rather than in a constructor argument nobody reads.
 *
 * The TTL must exceed the job's p99 runtime: a lease that expires mid-run means two tasks
 * draining the outbox at once, which is the failure `pix_event_outbox_due` + SKIP LOCKED is
 * there to survive but should not have to.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const JOB_LOCK_KEY = 'payzeno:job_lock';

export interface JobLockSpec {
  name: string;
  ttlSec: number;
}

export const JobLock = (name: string, ttlSec: number): CustomDecorator =>
  SetMetadata(JOB_LOCK_KEY, { name, ttlSec } satisfies JobLockSpec);
