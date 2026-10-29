import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';
import {
  type EventType,
  isEventOfType,
  type PayzenoEvent,
  type SettlementCompletedPayload,
  type SettlementDuplicateDetectedPayload,
  type SettlementVarianceDetectedPayload,
} from '@payzeno/contracts/events';
import type { CurrencyCode, MerchantId } from '@payzeno/contracts';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { AuditService } from '../audit/audit.service';
import { ChargesService } from '../payments/charges.service';
import { formatMoney } from '../common/money/money.util';
import { BankAccountRepository } from '../merchants/bank-accounts/bank-accounts.service';
import { MerchantMailerService } from '../merchants/merchant-mailer.service';
import { MerchantsService } from '../merchants/merchants.service';
import { SupportTasksService } from '../support/support-tasks.service';
import { BaseEventConsumer } from './consumer';
import { ProcessedEventRepository } from './processed-event.repository';
import { SettlementCompletion } from './settlement-completion.entity';

/**
 * Queue `payzeno-api-ledger`. The API side of the money path.
 *
 * This file is arc INC's blast radius. Two of its branches were written at 02:40 on the
 * night of PAY-2041 and hardened over the following fortnight:
 *
 *   settlement.completed          chunk accounting (PAY-2052, migration 25). The event is
 *                                 the SOLE driver of `charge captured -> settled` and it is
 *                                 chunked at 1000 ids over an unordered at-least-once bus.
 *   settlement.duplicate_detected added by the hotfix. Writes an audit row always, and opens
 *                                 a support task when the merchant is on capture-at-settlement
 *                                 — those are the merchants who can actually be double-charged.
 *
 * Collaborators are resolved through `ModuleRef` in `onModuleInit`, not constructor-injected,
 * because `EventsModule` must never import a feature module (it would close a cycle through
 * `PaymentsModule -> EventsModule`). docs/adr/0009-event-consumer-wiring.md.
 */
@Injectable()
export class LedgerEventsConsumer extends BaseEventConsumer implements OnModuleInit {
  readonly queueUrl: string;
  readonly consumerName = 'ledger-events';

  readonly handledTypes = new Set<EventType>([
    'settlement.completed',
    'settlement.duplicate_detected',
    'settlement.variance_detected',
    'payout.paid',
    'payout.failed',
    'payout.returned',
    'ledger.imbalance_detected',
  ]);

  private charges!: ChargesService;
  private merchants!: MerchantsService;
  private audit!: AuditService;
  private supportTasks!: SupportTasksService;
  private mailer!: MerchantMailerService;
  private bankAccounts!: BankAccountRepository;

  constructor(
    sqs: SQSClient,
    transactions: TransactionManager,
    processedEvents: ProcessedEventRepository,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly moduleRef: ModuleRef,
  ) {
    super(sqs, transactions, processedEvents, logger);
    this.queueUrl = this.config.aws.sqsLedgerQueueUrl;
  }

  onModuleInit(): void {
    this.charges = this.moduleRef.get(ChargesService, { strict: false });
    this.merchants = this.moduleRef.get(MerchantsService, { strict: false });
    this.audit = this.moduleRef.get(AuditService, { strict: false });
    this.supportTasks = this.moduleRef.get(SupportTasksService, { strict: false });
    this.mailer = this.moduleRef.get(MerchantMailerService, { strict: false });
    this.bankAccounts = this.moduleRef.get(BankAccountRepository, { strict: false });
  }

  async handle(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    if (isEventOfType(event, 'settlement.completed')) {
      await this.onSettlementCompleted(event.payload, event.id, tx);
      return;
    }
    if (isEventOfType(event, 'settlement.duplicate_detected')) {
      await this.onDuplicateDetected(event.payload, event.id, tx);
      return;
    }
    if (isEventOfType(event, 'settlement.variance_detected')) {
      await this.onVarianceDetected(event.payload, event.id, tx);
      return;
    }
    if (
      isEventOfType(event, 'payout.paid') ||
      isEventOfType(event, 'payout.failed') ||
      isEventOfType(event, 'payout.returned')
    ) {
      await this.onPayoutOutcome(event, tx);
      return;
    }
    if (isEventOfType(event, 'ledger.imbalance_detected')) {
      const merchantId = event.payload.merchant_id;
      if (!merchantId) {
        // A `trial_balance` imbalance belongs to no merchant and `support_task` is
        // merchant-scoped, so there is no row to open. Same shape as the unattributed
        // duplicate branch below, at error because the event is `critical`.
        this.logger.error('ledger.imbalance_unattributed', undefined, {
          check: event.payload.check,
          currency: event.payload.currency,
          delta_minor: event.payload.delta_minor,
          source_event_id: event.id,
        });
        return;
      }
      await this.supportTasks.open(tx, {
        kind: 'ledger_imbalance',
        merchantId,
        chargeId: null,
        severity: 'critical',
        title: `Ledger imbalance detected (${event.payload.check})`,
        body:
          `check=${event.payload.check} currency=${event.payload.currency} ` +
          `expected=${event.payload.expected_minor} actual=${event.payload.actual_minor} ` +
          `delta=${event.payload.delta_minor} ` +
          `sample=${event.payload.sample_transaction_ids.join(',')}`,
        sourceEventId: event.id,
      });
    }
  }

  /**
   * PAY-2052. Record the chunk, mark this chunk's charges settled, and close the batch out
   * only once every index 0..chunk_count-1 has arrived.
   *
   * The conditional upsert is not decoration: chunks arrive out of order and a redelivered
   * chunk must not double-count `charges_marked`. `chunks_seen` is a set, so re-applying an
   * index is a no-op — which is what makes the whole thing safe under at-least-once.
   */
  private async onSettlementCompleted(
    payload: SettlementCompletedPayload,
    sourceEventId: string,
    tx: EntityManager,
  ): Promise<void> {
    const marked = await this.charges.markSettledFromBatch(tx, payload.settled_charge_ids, {
      settlementBatchId: payload.batch_id,
      settledAt: payload.completed_at,
    });

    await tx.query(
      `insert into settlement_completion
         (batch_id, run_id, chunk_count, chunks_seen, charges_marked, created_at, updated_at)
       values ($1, $2, $3, array[$4::smallint], $5, now(), now())
       on conflict (batch_id, run_id) do update
          set chunks_seen = (
                select array_agg(distinct c order by c)
                  from unnest(settlement_completion.chunks_seen || excluded.chunks_seen) as c
              ),
              charges_marked = settlement_completion.charges_marked + excluded.charges_marked,
              updated_at = now()
        where not (excluded.chunks_seen <@ settlement_completion.chunks_seen)`,
      [payload.batch_id, payload.run_id, payload.chunk_count, payload.chunk_index, marked],
    );

    const completion = await tx.findOneBy(SettlementCompletion, {
      batchId: payload.batch_id,
      runId: payload.run_id,
    });

    if (completion && completion.completedAt === null && completion.hasAllChunks()) {
      await tx.update(
        SettlementCompletion,
        { batchId: payload.batch_id, runId: payload.run_id },
        { completedAt: new Date(payload.completed_at), updatedAt: new Date() },
      );
      this.logger.info('settlement.batch_complete', {
        batch_id: payload.batch_id,
        run_id: payload.run_id,
        chunks: payload.chunk_count,
        charges_marked: completion.chargesMarked + marked,
        source_event_id: sourceEventId,
      });
    } else if (completion) {
      this.logger.info('settlement.chunk_recorded', {
        batch_id: payload.batch_id,
        run_id: payload.run_id,
        chunk_index: payload.chunk_index,
        missing: completion.missingChunks().join(','),
        source_event_id: sourceEventId,
      });
    }
  }

  /**
   * arc INC. The ledger refused a duplicate posting; we want the evidence on the merchant's
   * audit trail either way, and a human on it when the merchant is one of the
   * capture-at-settlement ones — those are the merchants whose cardholder actually saw two
   * charges rather than two ledger rows.
   *
   * `charge_id` and `merchant_id` are nullable on purpose (data-model §3.5): an orphaned
   * reconciliation item has neither, and dropping the event on the floor because we could
   * not resolve a charge is what made the first hour of PAY-2041 so quiet.
   */
  private async onDuplicateDetected(
    payload: SettlementDuplicateDetectedPayload,
    sourceEventId: string,
    tx: EntityManager,
  ): Promise<void> {
    await this.audit.record(tx, {
      merchantId: payload.merchant_id,
      actorType: 'system',
      actorId: 'payzeno-ledger',
      action: 'settlement.duplicate_detected',
      resourceType: 'charge',
      resourceId: payload.charge_id,
      before: null,
      after: {
        batch_id: payload.batch_id,
        item_id: payload.item_id,
        idempotency_key: payload.idempotency_key,
        existing_transaction_id: payload.existing_transaction_id,
        detected_by: payload.detected_by,
        amount_minor: payload.amount_minor,
        currency: payload.currency,
      },
      livemode: true,
    });

    if (!payload.charge_id || !payload.merchant_id) {
      this.logger.warn('settlement.duplicate_unattributed', {
        batch_id: payload.batch_id,
        item_id: payload.item_id,
        detected_by: payload.detected_by,
      });
      return;
    }

    const merchant = await this.merchants.findInternal(payload.merchant_id);
    if (!merchant?.captureAtSettlement) {
      return;
    }

    await this.supportTasks.open(tx, {
      kind: 'duplicate_settlement',
      merchantId: payload.merchant_id,
      chargeId: payload.charge_id,
      severity: 'high',
      title: `Possible double charge on ${payload.charge_id}`,
      body:
        `The ledger refused a second posting for item ${payload.item_id} in batch ` +
        `${payload.batch_id} (detected_by=${payload.detected_by}, ` +
        `existing_transaction=${payload.existing_transaction_id}). This merchant captures at ` +
        `settlement, so verify the acquirer only captured once before refunding.`,
      sourceEventId,
    });
  }

  /**
   * The acquirer settled a different amount than we authorised. Nothing is posted beyond
   * tolerance, so the merchant's balance is right and the file is wrong — which is exactly
   * the failure the PAY-2041 postmortem calls undetectable without this branch.
   */
  private async onVarianceDetected(
    payload: SettlementVarianceDetectedPayload,
    sourceEventId: string,
    tx: EntityManager,
  ): Promise<void> {
    await this.audit.record(tx, {
      merchantId: payload.merchant_id,
      actorType: 'system',
      actorId: 'payzeno-ledger',
      action: 'settlement.variance_detected',
      resourceType: 'settlement_batch',
      resourceId: payload.batch_id,
      before: { expected_gross_minor: payload.expected_gross_minor },
      after: {
        actual_gross_minor: payload.actual_gross_minor,
        variance_minor: payload.variance_minor,
        tolerance_minor: payload.tolerance_minor,
        line_type: payload.line_type,
      },
      livemode: true,
    });

    if (Math.abs(payload.variance_minor) > payload.tolerance_minor && payload.merchant_id) {
      await this.supportTasks.open(tx, {
        kind: 'settlement_variance',
        merchantId: payload.merchant_id,
        chargeId: payload.charge_id,
        severity: 'normal',
        title: `Settlement variance on batch ${payload.batch_id}`,
        body:
          `expected=${payload.expected_gross_minor} actual=${payload.actual_gross_minor} ` +
          `variance=${payload.variance_minor} tolerance=${payload.tolerance_minor} ` +
          `${payload.currency}. Item ${payload.item_id} is parked at variance_exceeded.`,
        sourceEventId,
      });
    }
  }

  /**
   * Payouts are owned by the ledger; payzeno-api keeps the audit trail so the console's
   * activity feed and a support agent's timeline agree with the ledger's.
   */
  private async onPayoutOutcome(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    const payload = event.payload as { payout_id: string; merchant_id: string };
    await this.audit.record(tx, {
      merchantId: payload.merchant_id,
      actorType: 'system',
      actorId: 'payzeno-ledger',
      action: event.type,
      resourceType: 'payout',
      resourceId: payload.payout_id,
      before: null,
      after: event.payload as unknown as Record<string, unknown>,
      livemode: event.livemode,
    });

    await this.emailPayoutOutcome(event, tx);
  }

  /**
   * RFC platform-v2 §2: `payout_paid` / `payout_failed` to the merchant's owners and admins, in
   * the handler's transaction — a redelivered event is already claimed and emails nobody twice.
   * A return is a failure as far as the merchant is concerned: the money came back.
   *
   * `payout.paid` carries no bank account, so the last four are the default account's for the
   * payout currency — the account a scheduled payout goes to. Blank when there is none.
   */
  private async emailPayoutOutcome(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    if (isEventOfType(event, 'payout.paid')) {
      const { merchant_id: merchantId, amount_minor: amountMinor, currency } = event.payload;
      await this.mailer.queueToAdmins(
        merchantId,
        'payout_paid',
        {
          amount: formatMoney({ amount_minor: amountMinor, currency }),
          bank_last4: await this.defaultBankLast4(merchantId, currency, event.livemode),
        },
        { manager: tx, livemode: event.livemode },
      );
      return;
    }

    if (isEventOfType(event, 'payout.failed')) {
      const payload = event.payload;
      const account = await this.bankAccounts.findOne({ where: { id: payload.bank_account_id } });
      await this.mailer.queueToAdmins(
        payload.merchant_id,
        'payout_failed',
        {
          amount: formatMoney({ amount_minor: payload.amount_minor, currency: payload.currency }),
          bank_last4: account?.lastFour ?? null,
          failure_reason: payload.failure_message || payload.failure_code.replace(/_/g, ' '),
        },
        { manager: tx, livemode: event.livemode },
      );
      return;
    }

    if (isEventOfType(event, 'payout.returned')) {
      const payload = event.payload;
      await this.mailer.queueToAdmins(
        payload.merchant_id,
        'payout_failed',
        {
          amount: formatMoney({ amount_minor: payload.amount_minor, currency: payload.currency }),
          bank_last4: await this.defaultBankLast4(payload.merchant_id, payload.currency, event.livemode),
          failure_reason: `returned by the bank (${payload.return_code})`,
        },
        { manager: tx, livemode: event.livemode },
      );
    }
  }

  private async defaultBankLast4(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
  ): Promise<string | null> {
    const account = await this.bankAccounts.findDefault(merchantId, currency, livemode);
    return account?.lastFour ?? null;
  }
}
