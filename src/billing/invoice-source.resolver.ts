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
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async list(merchantId: MerchantId, filter: InvoiceListFilter): Promise<ResolvedInvoiceList> {
    if (this.flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)) {
      return { source: 'ledger', page: await this.listFromLedger(merchantId, filter) };
    }

  }
}

/** The list shape the legacy client returns, narrowed for the resolver's callers. */
export type LegacyInvoiceList = InvoiceListResponse;
