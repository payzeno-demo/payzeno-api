/**
 * CheckoutExpiryJob — every 10 minutes.
 *
 * Open checkout sessions past `expires_at` (24h after creation) become `expired`, and the
 * PaymentIntent behind each is cancelled with reason `abandoned` — which emits
 * `payment.canceled`, the event a shop listens for to release whatever it was holding for the
 * order. The reads reconcile the same way lazily, so this job is what catches the sessions
 * nobody looks at again.
 *
 * Ten minutes is the resolution a shop's "your reservation has expired" email needs; the
 * partial index `pix_checkout_session_open_expiry` keeps the scan cheap at any interval.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CheckoutSessionsService } from '../checkout/checkout-sessions.service';
import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

@Injectable()
export class CheckoutExpiryJob extends ScheduledJob {
  readonly name = 'checkout-expiry';
  readonly cronExpression = '*/10 * * * *';

  constructor(
    private readonly sessions: CheckoutSessionsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('*/10 * * * *', { name: 'checkout-expiry' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('checkout-expiry', 300)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const { expired, failed } = await this.sessions.expireDue(
        this.clock.now(),
        JOB_BATCH_LIMITS.checkoutExpiry,
      );

      return {
        processed: expired + failed,
        failed,
        truncated: expired + failed >= JOB_BATCH_LIMITS.checkoutExpiry,
        durationMs: Date.now() - startedMs,
        details: { expired },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }
}
