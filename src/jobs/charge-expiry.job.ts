/**
 * ChargeExpiryJob — hourly.
 *
 * An authorisation is a hold on the cardholder's funds, not a payment. Card networks expire
 * it after seven days (thirty for the travel and lodging MCCs — `ChargeExpiryPolicy`), and
 * after that a capture will simply be declined. Leaving the charge `authorized` forever means
 * the console shows a merchant a Capture button that cannot work, and the ledger keeps the
 * `auth_hold` posting on the books against money nobody is going to take.
 *
 * So: read `ix_charge_authorization_expires`, transition `authorized -> expired`, and release
 * the hold in the ledger. The ledger call is the part that matters — the row is bookkeeping,
 * the posting is the merchant's available balance.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import type { ChargeEntity } from '../payments/charge.entity';
import { ChargeExpiryPolicy } from '../payments/charge-expiry.policy';
import { ChargeRepository } from '../payments/charge.repository';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

@Injectable()
export class ChargeExpiryJob extends ScheduledJob {
  readonly name = 'charge-expiry';
  readonly cronExpression = '0 * * * *';

  constructor(
    private readonly charges: ChargeRepository,
    private readonly expiry: ChargeExpiryPolicy,
    private readonly ledger: LedgerReadThroughService,
    private readonly transactions: TransactionManager,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('0 * * * *', { name: 'charge-expiry' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('charge-expiry', 900)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const now = this.clock.now();
      const expiring = await this.charges.findExpiredAuthorizations(
        now,
        JOB_BATCH_LIMITS.chargeExpiry,
      );

      let expired = 0;
      let failed = 0;

      for (const charge of expiring) {
        try {
          if (await this.expireOne(charge)) {
            expired += 1;
          }
        } catch (err) {
          failed += 1;
          // Leave the row `authorized`. The next hour retries it, and an authorisation that
          // is already dead at the network stays dead — there is nothing to lose by waiting.
          this.logger.error('charge_expiry.failed', err, {
            charge_id: charge.id,
            merchant_id: charge.merchantId,
          });
        }
      }

      return {
        processed: expiring.length,
        failed,
        truncated: expiring.length >= JOB_BATCH_LIMITS.chargeExpiry,
        durationMs: Date.now() - startedMs,
        details: { expired },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /**
   * Belt and braces on the policy: the row's `authorization_expires_at` was written at
   * authorisation time from the merchant's MCC, and re-asking the policy here means a charge
   * whose window was mis-stamped by an older release is not expired early.
   */
  private async expireOne(charge: ChargeEntity): Promise<boolean> {
    if (!this.expiry.isExpired(charge.authorization_expires_at)) {
      this.logger.debug('charge_expiry.not_yet', {
        charge_id: charge.id,
        expires_at: charge.authorization_expires_at?.toISOString() ?? null,
      });
      return false;
    }

    const affected = await this.transactions.runInTransaction(async (tx) =>
      this.charges.markExpired(tx, charge.id),
    );

    if (affected === 0) {
      // Captured or voided since the read. The capture path owns the transition now.
      return false;
    }

    await this.ledger.releaseAuthorization({
      chargeId: charge.id,
      merchantId: charge.merchantId,
      currency: charge.currency,
      livemode: charge.livemode,
      amountMinor: charge.amount_minor,
    });

    this.logger.info('charge.authorization_expired', {
      charge_id: charge.id,
      merchant_id: charge.merchantId,
      amount_minor: charge.amount_minor,
      currency: charge.currency,
      expires_at: charge.authorization_expires_at?.toISOString() ?? null,
    });
    return true;
  }
}
