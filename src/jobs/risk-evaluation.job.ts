/**
 * RiskEvaluationJob — daily at 04:00 UTC.
 *
 * Walks active merchants, asks `RiskEvaluationService` for the trailing-30-day dispute rate,
 * and restricts anyone over 100 basis points. Restriction is a real status transition:
 * `MerchantStatusStateMachine` refuses an illegal one and `merchant.status_changed` goes on
 * the bus, so the ledger and the legacy biller learn about it without a second code path.
 *
 * The lease matters more here than anywhere else. Without it three tasks each restrict the
 * same merchant and each emit `merchant.status_changed`, and the ledger's projection applies
 * three identical updates while the merchant gets three emails. `SKIP LOCKED` does not save
 * us here — there is no queue, only a scan.
 *
 * 04:00 is after the settlement files land, so today's disputes are in the numerator.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { RiskEvaluationService } from '../merchants/risk/risk-evaluation.service';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

@Injectable()
export class RiskEvaluationJob extends ScheduledJob {
  readonly name = 'risk-evaluation';
  readonly cronExpression = '0 4 * * *';

  constructor(
    private readonly risk: RiskEvaluationService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @JobLock('risk-evaluation', 1800)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const evaluatedAt = this.clock.now();
      const outcomes = await this.risk.evaluateActiveMerchants(
        evaluatedAt,
        JOB_BATCH_LIMITS.riskEvaluation,
      );

      let restricted = 0;
      let released = 0;
      let failed = 0;

      for (const outcome of outcomes) {
        if (outcome.error) {
          failed += 1;
          this.logger.error('risk.evaluation_failed', outcome.error, {
            merchant_id: outcome.merchantId,
          });
          continue;
        }

        if (outcome.action === 'restricted') {
          restricted += 1;
          // Somebody in risk reads this every morning. Keep the numerator and the
          // denominator on the line — a rate with no volume behind it is not actionable.
          this.logger.warn('risk.merchant_restricted', {
            merchant_id: outcome.merchantId,
            dispute_rate_bps: outcome.disputeRateBps,
            disputes: outcome.disputeCount,
            charges: outcome.chargeCount,
          });
        } else if (outcome.action === 'released') {
          released += 1;
          this.logger.info('risk.merchant_released', {
            merchant_id: outcome.merchantId,
            dispute_rate_bps: outcome.disputeRateBps,
          });
        }
      }

      return {
        processed: outcomes.length,
        failed,
        truncated: outcomes.length >= JOB_BATCH_LIMITS.riskEvaluation,
        durationMs: Date.now() - startedMs,
        details: { restricted, released },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }
}
