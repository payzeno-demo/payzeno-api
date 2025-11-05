import { Test } from '@nestjs/testing';

import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { NoopLogger, PAYZENO_LOGGER } from 'src/common/logging/logger';
import { BillingLegacyClient } from 'src/billing/billing-legacy.client';
import { InvoiceSourceResolver } from 'src/billing/invoice-source.resolver';
import { InvoicesService } from 'src/billing/invoices.service';
import { InvoiceProjectionService } from 'src/billing/projection/invoice-projection.service';

import { makeApiKeyPrincipal } from 'test/factories/principal.factory';

/**
 * payzeno-api owns no invoice data, so this service is mostly a scope check and a cache
 * invalidation. The scope check is the load-bearing part: the legacy service will hand any
 * caller any invoice by id and has no notion of a tenant, so a cross-tenant read has to be
 * caught here or not at all.
 */
describe('InvoicesService', () => {
  let service: InvoicesService;
  let legacy: jest.Mocked<BillingLegacyClient>;
  function invoice(overrides: Record<string, unknown> = {}) {
    return {
      id: 'inv_1',
      object: 'invoice',
      merchant_id: 'mch_test01',
      status: 'open',
      total_minor: 12_000,
      ...overrides,
    } as never;
  }

});
