/**
 * DisputeDeadlineReminderJob — daily at 07:00 UTC.
 *
 * Two passes over `pix_dispute_evidence_due`:
 *
 *   reminders  disputes still `needs_response` whose evidence is due inside the warning
 *              window. One log line each — `dispute.evidence_due_soon` is the metric filter
 *              behind the merchant digest and the internal "about to lose money" dashboard.
 *   expiries   disputes past `evidence_due_by` with nothing submitted. The network has
 *              already decided; leaving them `needs_response` means the console shows a
 *              merchant an action button that does nothing. `DisputesService.closeAsLost`
 *              transitions them and emits `dispute.closed`.
 *
 * 07:00 UTC is deliberate: it is before the European working day and after the US one, so a
 * merchant who acts on the reminder still has a full day of the window left.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { DisputesService } from '../disputes/disputes.service';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

/** Warn this far ahead. Two days is the shortest useful notice for a merchant gathering evidence. */
const REMINDER_WINDOW_HOURS = 72;

@Injectable()
export class DisputeDeadlineReminderJob extends ScheduledJob {
  readonly name = 'dispute-deadline-reminder';
  readonly cronExpression = '0 7 * * *';

  constructor(
    private readonly disputes: DisputesService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('0 7 * * *', { name: 'dispute-deadline-reminder' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('dispute-deadline-reminder', 600)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const now = this.clock.now();
      const expired = await this.expireOverdue(now);
      const reminded = await this.remindDueSoon(now);

      return {
        processed: expired + reminded,
        failed: 0,
        truncated: expired + reminded >= JOB_BATCH_LIMITS.disputeReminder,
        durationMs: Date.now() - startedMs,
        details: { expired, reminded },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /**
   * Past the deadline with no evidence. Closing these is not a courtesy — an open dispute
   * holds the disputed amount out of the merchant's available balance, and the ledger only
   * releases it on `dispute.closed`.
   */
  private async expireOverdue(now: Date): Promise<number> {
    const overdue = await this.disputes.listPendingEvidence(now, JOB_BATCH_LIMITS.disputeReminder);
    let closed = 0;

    for (const dispute of overdue) {
      try {
        await this.disputes.closeAsLost(dispute.id, 'evidence_window_elapsed');
        closed += 1;

        this.logger.info('dispute.expired_unanswered', {
          dispute_id: dispute.id,
          merchant_id: dispute.merchantId,
          charge_id: dispute.chargeId,
          amount_minor: dispute.amountMinor,
          evidence_due_by: dispute.evidenceDueBy?.toISOString() ?? null,
        });
      } catch (err) {
        // One dispute that will not transition must not stop the other 499. The state
        // machine refusing is the interesting case: it means somebody submitted evidence
        // between the read and the write, and that dispute is fine.
        this.logger.error('dispute.expire_failed', err, { dispute_id: dispute.id });
      }
    }

    return closed;
  }

  /** Everything due inside the window, one line each. */
  private async remindDueSoon(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 3_600_000);
    const upcoming = await this.disputes.listPendingEvidence(
      cutoff,
      JOB_BATCH_LIMITS.disputeReminder,
    );

    const dueSoon = upcoming.filter(
      (dispute) => dispute.evidenceDueBy !== null && dispute.evidenceDueBy > now,
    );

    for (const dispute of dueSoon) {
      const hoursLeft = Math.round(
        (Number(dispute.evidenceDueBy?.getTime() ?? 0) - now.getTime()) / 3_600_000,
      );

      this.logger.warn('dispute.evidence_due_soon', {
        dispute_id: dispute.id,
        merchant_id: dispute.merchantId,
        charge_id: dispute.chargeId,
        amount_minor: dispute.amountMinor,
        hours_left: hoursLeft,
      });
    }

    return dueSoon.length;
  }
}
