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
    const merchantId = merchantIdOf(principal);
  }
}
