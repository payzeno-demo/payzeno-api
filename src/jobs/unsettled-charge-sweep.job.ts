/**
 * UnsettledChargeSweepJob — every six hours. PAY-2058, written after PAY-2041.
 *
 * `settlement.completed` is the SOLE driver of `charge captured -> settled`, it is chunked at
 * 1000 ids, and the bus is at-least-once and explicitly unordered. A chunk lost to the DLQ
 * therefore strands its charges `captured` with a null `settlement_batch_id` **forever**:
 * `LedgerEventsConsumer` never sees the ids, `settlement_completion` never reaches its chunk
 * count, and nothing else looks. `pix_charge_unsettled` existed for six months with no
 * reader at all.
 *
 * This job is that reader. For every charge captured longer ago than the settlement SLA it
 * asks the ledger directly — `GET /internal/v1/transactions?reference_type=charge` — and if
 * the ledger has posted a settle transaction for it, marks it settled here. Anything the
 * ledger has no record of is reported, not guessed at: a charge the ledger never settled is
 * either money we have not been paid or a reconciliation orphan, and both need a human.
 *
 * docs/runbooks/payzeno-api.md, "unsettled charge sweep". — apager
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import type { LedgerTransaction } from '@payzeno/contracts';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { LedgerHttpClient } from '../ledger/ledger-http.client';
import type { ChargeEntity } from '../payments/charge.entity';
import { ChargeRepository } from '../payments/charge.repository';

import { JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

/**
 * How long after capture a charge is expected to have settled. Two banking days plus a
 * margin: anything younger than this is simply in flight, and sweeping it would hammer the
 * ledger for nothing.
 */
const SETTLEMENT_SLA_HOURS = 72;

/** Ledger purposes that mean "this charge settled". */
const SETTLING_PURPOSES = new Set(['settle', 'settlement', 'settlement_capture']);

@Injectable()
export class UnsettledChargeSweepJob extends ScheduledJob {
  readonly name = 'unsettled-charge-sweep';
  readonly cronExpression = '0 */6 * * *';

  constructor(
    private readonly charges: ChargeRepository,
    private readonly ledger: LedgerHttpClient,
    private readonly transactions: TransactionManager,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('0 */6 * * *', { name: 'unsettled-charge-sweep' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('unsettled-charge-sweep', 1800)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const cutoff = new Date(this.clock.nowMs() - SETTLEMENT_SLA_HOURS * 3_600_000);
      const stranded = await this.charges.findStrandedCaptures(
        cutoff,
        JOB_BATCH_LIMITS.unsettledSweep,
      );

      let healed = 0;
      let unresolved = 0;
      let failed = 0;

      for (const charge of stranded) {
        try {
          const settled = await this.heal(charge);
          if (settled) {
            healed += 1;
          } else {
            unresolved += 1;
          }
        } catch (err) {
          failed += 1;
          this.logger.error('sweep.charge_failed', err, { charge_id: charge.id });
        }
      }

      if (unresolved > 0) {
        // This is the alarm. A charge the ledger has never heard of, three days after we
        // captured it, is either an orphaned reconciliation item or money we were not paid.
        this.logger.error('sweep.unresolved_charges', null, {
          job: this.name,
          unresolved,
          scanned: stranded.length,
          cutoff: cutoff.toISOString(),
        });
      }

      return {
        processed: stranded.length,
        failed,
        truncated: stranded.length >= JOB_BATCH_LIMITS.unsettledSweep,
        durationMs: Date.now() - startedMs,
        details: { healed, unresolved, cutoff: cutoff.toISOString() },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /**
   * Ask the ledger what it knows about this charge. If it has posted a settle transaction,
   * we lost the event and not the money — stamp the batch id from the transaction's
   * reference and mark the charge settled through the same repository method the event path
   * uses. If it has not, leave the row alone and let the caller count it.
   */
  private async heal(charge: ChargeEntity): Promise<boolean> {
    const page = await this.ledger.listTransactions({
      merchant_id: charge.merchantId,
      reference_type: 'charge',
      reference_id: charge.id,
      limit: 20,
    });

    const settlement = page.data.find(isSettlementTransaction);
    if (!settlement) {
      this.logger.warn('sweep.no_ledger_settlement', {
        charge_id: charge.id,
        merchant_id: charge.merchantId,
        captured_at: charge.captured_at?.toISOString() ?? null,
        ledger_transactions: page.data.length,
      });
      return false;
    }

    const batchId = settlementBatchIdOf(settlement);
    if (!batchId) {
      // The ledger settled it but the transaction carries no batch reference. Rare, and it
      // means the item was posted by a manual adjustment rather than a batch pass.
      this.logger.warn('sweep.settlement_without_batch', {
        charge_id: charge.id,
        transaction_id: settlement.id,
      });
      return false;
    }

    const settledAt = new Date(settlement.posted_at);

    const affected = await this.transactions.runInTransaction(async (tx) =>
      this.charges.markSettled(tx, [charge.id], batchId, settledAt),
    );

    if (affected === 0) {
      // Somebody else got there between the read and the write — the missing chunk was
      // redelivered while we were working. Nothing to do and nothing wrong.
      return false;
    }

    this.logger.info('sweep.charge_healed', {
      charge_id: charge.id,
      merchant_id: charge.merchantId,
      batch_id: batchId,
      transaction_id: settlement.id,
      stranded_hours: Math.round(
        (this.clock.nowMs() - (charge.captured_at?.getTime() ?? this.clock.nowMs())) / 3_600_000,
      ),
    });
    return true;
  }
}

function isSettlementTransaction(transaction: LedgerTransaction): boolean {
  return SETTLING_PURPOSES.has(transaction.purpose);
}

/**
 * The batch id lives on the settle transaction's metadata. The ledger stamps it there
 * because `ledger_transaction` has no settlement foreign key — the two databases are never
 * joined (data-model.md, conventions).
 */
function settlementBatchIdOf(transaction: LedgerTransaction): string | null {
  const metadata = (transaction as unknown as { metadata?: Record<string, unknown> }).metadata;
  const batchId = metadata?.settlement_batch_id;
  return typeof batchId === 'string' && batchId.length > 0 ? batchId : null;
}
