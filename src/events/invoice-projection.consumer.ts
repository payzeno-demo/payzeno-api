import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';
import { INVOICE_STATUSES, type InvoiceStatus } from '@payzeno/contracts';
import { type EventType, isEventOfType, type PayzenoEvent } from '@payzeno/contracts/events';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { InvoiceProjectionService } from '../billing/projection/invoice-projection.service';
import { BaseEventConsumer } from './consumer';
import { ProcessedEventRepository } from './processed-event.repository';

/**
 * Queue `payzeno-api-billing`. arc MIG.
 *
 * `invoice.issued` is the only thing payzeno-billing-legacy publishes, and this consumer is
 * what turns it into a row in `invoice_projection` (migration 20) so `GET /v1/invoices`
 * stops fanning out to the Java service on every request.
 *
 * Note what this is NOT: `invoice_projection` is a read cache of *payzeno-billing-legacy*,
 * not of the ledger. When `ledger_owns_invoices` flips, the writer of this table changes
 * from here + `BillingLegacyClient` to `LedgerHttpClient`, and nothing else changes. That
 * swap is the unfinished part of the arc. — nmigration
 */
@Injectable()
export class InvoiceProjectionConsumer extends BaseEventConsumer implements OnModuleInit {
  readonly queueUrl: string;
  readonly consumerName = 'invoice-projection';
  readonly handledTypes = new Set<EventType>(['invoice.issued']);

  private projection!: InvoiceProjectionService;

  constructor(
    sqs: SQSClient,
    transactions: TransactionManager,
    processedEvents: ProcessedEventRepository,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly moduleRef: ModuleRef,
  ) {
    super(sqs, transactions, processedEvents, logger);
    this.queueUrl = InvoiceProjectionConsumer.billingQueueUrl(this.config);
  }

  onModuleInit(): void {
    this.projection = this.moduleRef.get(InvoiceProjectionService, { strict: false });
  }

  async handle(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    if (!isEventOfType(event, 'invoice.issued')) {
      return;
    }
    const payload = event.payload;

    // The event types `status` as the legacy biller's string. A value outside the public
    // vocabulary is not guessed at — it throws, and redelivery takes it to the DLQ.
    if (!isInvoiceStatus(payload.status)) {
      throw new Error(`invoice.issued ${event.id} carries unknown invoice status "${payload.status}"`);
    }

    /**
     * Conditional upsert on `source_occurred_at`. Ordering is not guaranteed, so a
     * redelivered older `invoice.issued` must never overwrite a newer one — otherwise a
     * voided invoice quietly reverts to `open` in the console.
     */
    const applied = await this.projection.refresh(
      {
        invoiceId: payload.invoice_public_id,
        merchantId: payload.merchant_id,
        subscriptionId: payload.subscription_public_id,
        number: payload.number,
        status: payload.status,
        currency: payload.currency,
        subtotalMinor: payload.subtotal_minor,
        taxMinor: payload.tax_minor,
        totalMinor: payload.total_minor,
        periodStart: payload.period_start,
        periodEnd: payload.period_end,
        dueAt: payload.due_at,
        migratedToLedger: payload.migrated_to_ledger,
        sourceOccurredAt: event.occurred_at,
        source: 'billing_legacy',
      },
      tx,
    );

    this.logger.info(applied ? 'invoice_projection.updated' : 'invoice_projection.stale_skipped', {
      invoice_public_id: payload.invoice_public_id,
      merchant_id: payload.merchant_id,
      status: payload.status,
      migrated_to_ledger: payload.migrated_to_ledger,
      source_event_id: event.id,
    });
  }

  /**
   * There is no `SQS_API_BILLING_URL` in the config schema — the billing queue arrived with
   * migration 20 and the env var never got added, so the URL is derived from the DLQ's.
   *
   * TODO(PAY-1974): add SQS_API_BILLING_URL to .env.example, ApiConfig and config.schema.ts
   * and delete this. It has to land in the same PR as the terraform, which is why it hasn't.
   */
  private static billingQueueUrl(config: ApiConfig): string {
    return config.aws.sqsDlqUrl.replace(/payzeno-dlq-monitor$/, 'payzeno-api-billing');
  }
}

function isInvoiceStatus(value: string): value is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(value);
}
