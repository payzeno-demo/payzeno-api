/**
 * InvoicesService — api-surface.md §9 rows 14-16.
 *
 * payzeno-api owns no invoice data. Every read resolves through `InvoiceSourceResolver` and
 * every write goes to payzeno-billing-legacy, which is a Spring Boot service with a MySQL
 * database and its own idea of what an invoice is. This service's whole job is to make that
 * invisible to the console and to keep the legacy service off the hot path where it can.
 *
 * The one behaviour worth knowing: a void invalidates the projection row rather than updating
 * it, because the legacy service recomputes `amount_due_minor` on void and we would rather
 * refetch than reimplement that arithmetic (it has three special cases and one of them is
 * credit notes).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal, Invoice, MerchantId, Paginated } from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import type { ListQueryDto } from '../common/pagination/list-query.dto';
import { BillingLegacyClient } from './billing-legacy.client';
import { InvoiceSourceResolver } from './invoice-source.resolver';
import { InvoiceProjectionService } from './projection/invoice-projection.service';

export interface InvoiceListFilters {
  status?: string;
  cursor?: string;
  limit?: number;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly resolver: InvoiceSourceResolver,
    private readonly legacy: BillingLegacyClient,
    private readonly projection: InvoiceProjectionService,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async list(principal: AuthPrincipal, filters: InvoiceListFilters): Promise<Paginated<Invoice>> {
    const merchantId = merchantIdOf(principal);
    const resolved = await this.resolver.list(merchantId, {
      status: filters.status,
      cursor: filters.cursor,
      limit: filters.limit,
    });

    this.logger.debug('invoice_list_served', {
      merchant_id: merchantId,
      source: resolved.source,
      count: resolved.page.data.length,
      livemode: livemodeOf(principal),
    });

    return resolved.page;
  }

  async get(principal: AuthPrincipal, invoiceId: string): Promise<Invoice> {
    const merchantId = merchantIdOf(principal);
    const resolved = await this.resolver.get(merchantId, invoiceId);

    // The legacy service is happy to hand any caller any invoice by id; the scope check is
    // ours to make and it has to happen after the fetch, because the id carries no tenant.
    if (resolved.invoice.merchant_id !== merchantId) {
      this.logger.warn('invoice_cross_tenant_read_blocked', {
        merchant_id: merchantId,
        invoice_id: invoiceId,
        owner_merchant_id: resolved.invoice.merchant_id,
      });
      throw new ResourceNotFoundException('invoice', invoiceId);
    }

    return resolved.invoice;
  }

  /**
   * `POST /v1/invoices/:invoiceId/void` — admin only. Writes go straight to the legacy
   * service; there is no local copy to keep consistent, only a cache to drop.
   */
  async voidInvoice(principal: AuthPrincipal, invoiceId: string): Promise<Invoice> {
    const merchantId = merchantIdOf(principal);
    // Scope first: the void is irreversible in the legacy service and it has no tenant check.
    await this.get(principal, invoiceId);

    const voided = await this.legacy.voidInvoice(invoiceId);
    await this.projection.invalidateStatus(invoiceId, voided.status);

    this.logger.info('invoice_voided', {
      merchant_id: merchantId,
      invoice_id: invoiceId,
      status: voided.status,
      total_minor: voided.total_minor,
    });

    return voided;
  }

  /**
   * Used by the console's merchant statement page. Reads the deprecated statement endpoint —
   * every call logs `LEGACY_CALL_AFTER_MIGRATION` on the client, which is how we know how
   * much of arc MIG is left.
   *
   * TODO(PAY-1863): the ledger's balance history covers everything on this page except the
   * fee breakdown. Once `ledger_owns_fees` covers interchange, this goes away.
   */
  async statement(merchantId: MerchantId, period: string): Promise<unknown> {
    return this.legacy.getStatement(merchantId, period);
  }

  /** Page-size clamp lives with the DTO; this is the adapter from the query object. */
  filtersFrom(query: ListQueryDto, status?: string): InvoiceListFilters {
    return { status, cursor: query.cursor, limit: query.effectiveLimit() };
  }
}
