/**
 * SubscriptionRenewalJob — every minute. RFC platform-v2 §6.
 *
 * Charges every active subscription whose period has ended and retries every past-due one
 * whose retry is due, through `SubscriptionRenewalService`. Due-ness is "period end ≤ the
 * Clock", never "it is the first of the month", so after a simulated-clock jump the next run
 * finds everything that fell due in between and catches each subscription up period by period.
 *
 * Registered here, in RecurringBillingModule, rather than in JobsModule: it is the only job
 * that reaches checkout, customers and billing at once. `ScheduleModule` discovers `@Cron` on
 * any provider, and the `@JobLock` lease keeps it to one task like every other job.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import type { JobResult } from '../../jobs/job.types';
import { ScheduledJob } from '../../jobs/scheduled-job';

import { SubscriptionRenewalService } from './subscription-renewal.service';

/** Subscriptions picked up per run. Each may charge several periods after a clock jump. */
export const RENEWAL_BATCH_LIMIT = 200;

@Injectable()
export class SubscriptionRenewalJob extends ScheduledJob {
  readonly name = 'subscription-renewal';
  readonly cronExpression = '* * * * *';

  constructor(
    private readonly renewals: SubscriptionRenewalService,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('* * * * *', { name: 'subscription-renewal' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  /** 240s: a minute of acquirer round trips across a catch-up batch, with room to spare. */
  @JobLock('subscription-renewal', 240)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const counts = await this.renewals.renewDue(RENEWAL_BATCH_LIMIT);
      return {
        processed: counts.seen,
        failed: counts.errors,
        truncated: counts.seen >= RENEWAL_BATCH_LIMIT,
        durationMs: Date.now() - startedMs,
        details: {
          renewed: counts.renewed,
          payment_failed: counts.failed,
          canceled: counts.canceled,
          skipped: counts.skipped,
        },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }
}
