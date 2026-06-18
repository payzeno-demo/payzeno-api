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
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { AuditService } from '../audit/audit.service';
import { ChargesService } from '../payments/charges.service';
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
      await this.supportTasks.open(tx, {
        kind: 'ledger_imbalance',
        merchantId: event.payload.merchant_id,
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
