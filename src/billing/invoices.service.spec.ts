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
  let resolver: jest.Mocked<InvoiceSourceResolver>;
  let legacy: jest.Mocked<BillingLegacyClient>;
  let projection: jest.Mocked<InvoiceProjectionService>;

  const principal = makeApiKeyPrincipal({ merchant_id: 'mch_test01' });

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

  beforeEach(async () => {
    resolver = {
      list: jest.fn().mockResolvedValue({
        source: 'projection',
        page: { data: [invoice()], next_cursor: null, has_more: false },
      }),
      get: jest.fn().mockResolvedValue({ source: 'projection', invoice: invoice() }),
      currentSource: jest.fn().mockReturnValue('billing-legacy'),
    } as unknown as jest.Mocked<InvoiceSourceResolver>;

    legacy = {
      voidInvoice: jest.fn().mockResolvedValue(invoice({ status: 'void' })),
      getStatement: jest.fn().mockResolvedValue({ period: '2026-01' }),
    } as unknown as jest.Mocked<BillingLegacyClient>;

    projection = {
      invalidateStatus: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<InvoiceProjectionService>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: InvoiceSourceResolver, useValue: resolver },
        { provide: BillingLegacyClient, useValue: legacy },
        { provide: InvoiceProjectionService, useValue: projection },
        { provide: PAYZENO_LOGGER, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(InvoicesService);
  });

  describe('list', () => {
    it('resolves through the source resolver, never the legacy client directly', async () => {
      const page = await service.list(principal, { limit: 10 });

      expect(resolver.list).toHaveBeenCalledWith('mch_test01', expect.objectContaining({ limit: 10 }));
      expect(page.data).toHaveLength(1);
    });

    it('passes the status filter through', async () => {
      await service.list(principal, { status: 'open' });

      expect(resolver.list).toHaveBeenCalledWith(
        'mch_test01',
        expect.objectContaining({ status: 'open' }),
      );
    });
  });

  describe('get', () => {
    it('returns an invoice that belongs to the principal', async () => {
      await expect(service.get(principal, 'inv_1')).resolves.toMatchObject({ id: 'inv_1' });
    });

    it('404s an invoice belonging to another merchant', async () => {
      resolver.get.mockResolvedValue({
        source: 'billing-legacy',
        invoice: invoice({ merchant_id: 'mch_someone_else' }),
      } as never);

      await expect(service.get(principal, 'inv_other')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });

  describe('voidInvoice', () => {
    it('checks scope before voiding — the void is irreversible upstream', async () => {
      await service.voidInvoice(principal, 'inv_1');

      const scopeOrder = resolver.get.mock.invocationCallOrder[0];
      const voidOrder = legacy.voidInvoice.mock.invocationCallOrder[0];
      expect(scopeOrder).toBeLessThan(voidOrder);
    });

    it('drops the projection row rather than updating it', async () => {
      const result = await service.voidInvoice(principal, 'inv_1');

      expect(result.status).toBe('void');
      expect(projection.invalidateStatus).toHaveBeenCalledWith('inv_1', 'void');
    });

    it('does not call the legacy service for another merchant’s invoice', async () => {
      resolver.get.mockResolvedValue({
        source: 'billing-legacy',
        invoice: invoice({ merchant_id: 'mch_someone_else' }),
      } as never);

      await expect(service.voidInvoice(principal, 'inv_other')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      expect(legacy.voidInvoice).not.toHaveBeenCalled();
    });
  });

  describe('statement', () => {
    it('reads the deprecated statement endpoint (arc MIG, still live)', async () => {
      await service.statement('mch_test01', '2026-01');

      expect(legacy.getStatement).toHaveBeenCalledWith('mch_test01', '2026-01');
    });
  });
});
