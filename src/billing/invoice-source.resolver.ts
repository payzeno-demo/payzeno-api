/**
 * InvoiceSourceResolver — the arc MIG seam, and the most-read file in `src/billing/`.
 *
 * `GET /v1/invoices` has three possible sources and exactly one of them is live:
 *
 *   flag ledger_owns_invoices = false   (production, for six months now)
 *     → InvoiceProjectionService.list()             the read cache filled from the legacy
 *       ↳ miss → BillingLegacyClient.listInvoices()  service's own responses (migration 20)
 *
 *   flag ledger_owns_invoices = true    (never taken in production)
 *     → LedgerHttpClient.listStagedInvoiceLines()
 *
 * The ledger arm compiles, has a spec, and is dead. That is deliberate: step 4 of arc MIG is
 * the invoice cutover, the ledger side landed in migration 0022, and the flip has not
 * happened. `nmigration` wrote it; `dhotfix` argued in the PR that a dead arm is worse than
 * no arm, lost, and left the comment on line 1 of docs/adr/0012-invoice-cutover.md.
 *
 * When the flag flips, `invoice_projection`'s writer changes from BillingLegacyClient to
 * LedgerHttpClient and nothing else changes. That is the whole design.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Invoice, InvoiceListResponse, MerchantId, Paginated } from '@payzeno/contracts';

import { FeatureFlags } from '../common/flags/feature-flags';
import { FLAG_NAMES } from '../common/flags/flag-names';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { LedgerHttpClient } from '../ledger/ledger-http.client';
import { BillingLegacyClient, type InvoiceListFilter } from './billing-legacy.client';
import { InvoiceProjectionService } from './projection/invoice-projection.service';

export type InvoiceSource = 'projection' | 'billing-legacy' | 'ledger';

export interface ResolvedInvoiceList {
  source: InvoiceSource;
  page: Paginated<Invoice>;
}

@Injectable()
export class InvoiceSourceResolver {
  constructor(
    private readonly flags: FeatureFlags,
    private readonly legacy: BillingLegacyClient,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async list(merchantId: MerchantId, filter: InvoiceListFilter): Promise<ResolvedInvoiceList> {
    if (this.flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)) {
      return { source: 'ledger', page: await this.listFromLedger(merchantId, filter) };
    }

    const cached = await this.projection.get(merchantId, invoiceId);
    if (cached) {
      return { source: 'projection', invoice: cached };
    }

    return { source: 'billing-legacy', invoice: await this.legacy.getInvoice(invoiceId) };
  }

  /**
   * DEAD IN PRODUCTION. Reachable only with `ledger_owns_invoices=true`, which is set in
   * exactly one place: `invoice-source.resolver.spec.ts`.
   */
  private async listFromLedger(
    merchantId: MerchantId,
    filter: InvoiceListFilter,
  ): Promise<Paginated<Invoice>> {
    this.logger.warn('invoice_source_ledger_arm_taken', {
      merchant_id: merchantId,
      // If this ever appears in production logs, arc MIG step 4 has started and
      // docs/adr/0012-invoice-cutover.md is the thing to read before touching anything.
      flag: FLAG_NAMES.LEDGER_OWNS_INVOICES,
    });

    const cached = await this.projection.list(merchantId, {
      status: filter.status,
      cursor: filter.cursor,
      limit: filter.limit,
    });
    if (cached) {
      return cached;
    }

    const staged = await this.ledger.listStagedInvoiceLines(merchantId, filter.cursor ?? '');
    return {
      data: staged.lines.length === 0 ? [] : [this.assembleFromStagedLines(merchantId, filter.cursor ?? '', staged.lines)],
      next_cursor: null,
      has_more: false,
    };
  }

  /**
   * The ledger stages lines, not invoices — the header (number, dates, status) stays with the
   * legacy service until step 5. This is the join that makes the dead arm type-check, and it
   * is the part `dhotfix` objected to: it is a guess at a shape nobody has agreed.
   */
  private assembleFromStagedLines(
    merchantId: MerchantId,
    invoiceId: string,
    lines: ReadonlyArray<{ description: string; quantity: number; unit_amount_minor: number; amount_minor: number }>,
  ): Invoice {
  }
}

/** The list shape the legacy client returns, narrowed for the resolver's callers. */
export type LegacyInvoiceList = InvoiceListResponse;
