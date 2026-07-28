/**
 * The read cache in front of payzeno-billing-legacy.
 *
 * Writer today: `InvoiceProjectionConsumer` (`invoice.issued` on `payzeno-api-billing`).
 * Writer after the cutover: `LedgerHttpClient`. `InvoiceSourceResolver` is the switch.
 *
 * A miss is not an error — it means the merchant has invoices older than migration 20's
 * backfill window, and `InvoicesService` falls back to the legacy fan-out for them.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Invoice, InvoiceStatus, MerchantId, Paginated } from '@payzeno/contracts';

import { CLOCK, type Clock } from '../../common/time/clock';
import { InvoiceProjectionEntity } from './invoice-projection.entity';
import { InvoiceProjectionRepository, type InvoiceProjectionQuery } from './invoice-projection.repository';

export interface ProjectionUpsert {
  invoiceId: string;
  merchantId: MerchantId;
  subscriptionId: string | null;
  number: string;
  status: InvoiceStatus;
  currency: Invoice['currency'];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
  lines: Invoice['lines'];
  periodStart: string;
  periodEnd: string;
  dueAt: string | null;
  migratedToLedger: boolean;
  /** `EventEnvelope.occurred_at`, or the legacy response's `created_at` on a cache fill. */
  sourceOccurredAt: string;
  source: 'billing_legacy' | 'ledger';
}

@Injectable()
export class InvoiceProjectionService {
  constructor(
    private readonly projections: InvoiceProjectionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(merchantId: MerchantId, query: InvoiceProjectionQuery): Promise<Paginated<Invoice> | null> {
    const hasRows = await this.projections.hasRowsFor(merchantId);
    if (!hasRows) {
      return null;
    }
    const page = await this.projections.listForMerchant(merchantId, query);
    return {
      data: page.data.map(toInvoice),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  }

  async get(merchantId: MerchantId, invoiceId: string): Promise<Invoice | null> {
    const row = await this.projections.findByIdForMerchant(merchantId, invoiceId);
    return row ? toInvoice(row) : null;
  }

  /** Called by `InvoiceProjectionConsumer` on every `invoice.issued`. */
  async refresh(upsert: ProjectionUpsert): Promise<boolean> {
    return this.projections.upsertIfNewer({
      id: upsert.invoiceId,
      merchant_id: upsert.merchantId,
      subscription_id: upsert.subscriptionId,
      number: upsert.number,
      status: upsert.status,
      currency: upsert.currency,
      subtotal_minor: upsert.subtotalMinor,
      tax_minor: upsert.taxMinor,
      total_minor: upsert.totalMinor,
      amount_paid_minor: upsert.amountPaidMinor,
      lines: upsert.lines,
      period_start: upsert.periodStart,
      period_end: upsert.periodEnd,
      due_at: upsert.dueAt ? new Date(upsert.dueAt) : null,
      migrated_to_ledger: upsert.migratedToLedger,
      source_occurred_at: new Date(upsert.sourceOccurredAt),
      source: upsert.source,
      refreshed_at: this.clock.now(),
    });
  }

  /** Fills the cache from a legacy response, so the next read for this merchant is local. */
  async warm(merchantId: MerchantId, invoices: Invoice[]): Promise<number> {
    let written = 0;
    for (const invoice of invoices) {
      const ok = await this.refresh({
        invoiceId: invoice.id,
        merchantId,
        subscriptionId: invoice.subscription_id,
        number: invoice.number,
        status: invoice.status,
        currency: invoice.currency,
        subtotalMinor: invoice.subtotal_minor,
        taxMinor: invoice.tax_minor,
        totalMinor: invoice.total_minor,
        amountPaidMinor: invoice.amount_paid_minor,
        lines: invoice.lines,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        dueAt: invoice.due_at,
        migratedToLedger: invoice.migrated_to_ledger,
        sourceOccurredAt: invoice.created_at,
        source: 'billing_legacy',
      });
      if (ok) {
        written += 1;
      }
    }
    return written;
  }

  invalidateStatus(invoiceId: string, status: InvoiceStatus): Promise<void> {
    return this.projections.markStatus(invoiceId, status, this.clock.now());
  }
}

function toInvoice(row: InvoiceProjectionEntity): Invoice {
  return {
    id: row.id,
    object: 'invoice',
    merchant_id: row.merchant_id,
    subscription_id: row.subscription_id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    subtotal_minor: Number(row.subtotal_minor),
    tax_minor: Number(row.tax_minor),
    total_minor: Number(row.total_minor),
    amount_paid_minor: Number(row.amount_paid_minor),
    lines: row.lines,
    period_start: row.period_start,
    period_end: row.period_end,
    due_at: row.due_at ? row.due_at.toISOString() : null,
    migrated_to_ledger: row.migrated_to_ledger,
    created_at: row.created_at.toISOString(),
  };
}
