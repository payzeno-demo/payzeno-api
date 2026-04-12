import { FLAG_NAMES } from 'src/common/flags/flag-names';
import { StaticFeatureFlags } from 'src/common/flags/static-feature-flags';
import { NoopLogger } from 'src/common/logging/logger';
import { BillingLegacyClient } from 'src/billing/billing-legacy.client';
import { InvoiceSourceResolver } from 'src/billing/invoice-source.resolver';
import { InvoiceProjectionService } from 'src/billing/projection/invoice-projection.service';
import { LedgerHttpClient } from 'src/ledger/ledger-http.client';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The arc MIG seam.
 *
 * This spec is the ONLY place `ledger_owns_invoices` is ever true. The ledger arm
 * compiles, is covered here, and has never executed in production — that is step 4 of the
 * cutover and it is unfinished on purpose (docs/adr/0012-invoice-cutover.md).
 *
 * Keeping it covered is the point: the day the flag flips, this is the only evidence that
 * the arm works at all.
 */
describe('InvoiceSourceResolver', () => {
  let flags: StaticFeatureFlags;
  let projection: jest.Mocked<InvoiceProjectionService>;
  let legacy: jest.Mocked<BillingLegacyClient>;
  let ledger: jest.Mocked<LedgerHttpClient>;
  let logger: NoopLogger;
  let resolver: InvoiceSourceResolver;

  const invoice = { id: 'inv_0001', object: 'invoice', merchant_id: TEST_MERCHANT_ID } as never;

  beforeEach(() => {
    flags = new StaticFeatureFlags();
    projection = {
      list: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      warm: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<InvoiceProjectionService>;
    legacy = {
      listInvoices: jest.fn().mockResolvedValue({ data: [invoice], next_cursor: null, has_more: false }),
      getInvoice: jest.fn().mockResolvedValue(invoice),
    } as unknown as jest.Mocked<BillingLegacyClient>;
    ledger = {
      listStagedInvoiceLines: jest.fn().mockResolvedValue({ lines: [] }),
    } as unknown as jest.Mocked<LedgerHttpClient>;
    logger = new NoopLogger();
    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn');

    resolver = new InvoiceSourceResolver(flags, projection, legacy, ledger, logger);
  });

  describe('with ledger_owns_invoices OFF (production)', () => {
    it('serves a projection hit without touching the legacy service', async () => {
      projection.list.mockResolvedValue({ data: [invoice], next_cursor: null, has_more: false } as never);

      const result = await resolver.list(TEST_MERCHANT_ID, {});

      expect(result.source).toBe('projection');
      expect(legacy.listInvoices).not.toHaveBeenCalled();
      expect(ledger.listStagedInvoiceLines).not.toHaveBeenCalled();
    });

    it('fans out to the legacy service on a projection miss', async () => {
      const result = await resolver.list(TEST_MERCHANT_ID, {});

      expect(result.source).toBe('billing-legacy');
      expect(legacy.listInvoices).toHaveBeenCalledWith(TEST_MERCHANT_ID, {});
    });

    it('warms the projection on the way through a miss', async () => {
      await resolver.list(TEST_MERCHANT_ID, {});

      // Merchants onboarded before migration 20 have no rows until their next
      // `invoice.issued`; warming is what stops every request fanning out forever.
      expect(projection.warm).toHaveBeenCalledWith(TEST_MERCHANT_ID, [invoice]);
    });

    it('logs the miss so the cutover’s progress is measurable', async () => {
      await resolver.list(TEST_MERCHANT_ID, {});

      expect(logger.info).toHaveBeenCalledWith(
        'invoice_projection_miss',
        expect.objectContaining({ merchant_id: TEST_MERCHANT_ID, source: 'billing-legacy' }),
      );
    });

    it('never takes the ledger arm', async () => {
      await resolver.list(TEST_MERCHANT_ID, {});
      await resolver.get(TEST_MERCHANT_ID, 'inv_0001');

      expect(ledger.listStagedInvoiceLines).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        'invoice_source_ledger_arm_taken',
        expect.anything(),
      );
    });

    describe('get', () => {
      it('serves a projection hit', async () => {
        projection.get.mockResolvedValue(invoice);

        const result = await resolver.get(TEST_MERCHANT_ID, 'inv_0001');

        expect(result.source).toBe('projection');
        expect(legacy.getInvoice).not.toHaveBeenCalled();
      });

      it('falls through to the legacy service on a miss', async () => {
        const result = await resolver.get(TEST_MERCHANT_ID, 'inv_0001');

        expect(result.source).toBe('billing-legacy');
        expect(legacy.getInvoice).toHaveBeenCalledWith('inv_0001');
      });
    });
  });

  describe('with ledger_owns_invoices ON (never taken in production)', () => {
    it('still prefers the projection when it has the page', async () => {
      projection.list.mockResolvedValue({ data: [invoice], next_cursor: null, has_more: false } as never);

      const result = await resolver.list(TEST_MERCHANT_ID, {});

      // The projection's *writer* changes at the flip; its reader does not.
      expect(result.source).toBe('ledger');
      expect(result.page.data).toEqual([invoice]);
      expect(ledger.listStagedInvoiceLines).not.toHaveBeenCalled();
    });

    it('assembles an empty page when the ledger has no staged lines', async () => {
      const result = await resolver.list(TEST_MERCHANT_ID, {});

      expect(result.page.data).toEqual([]);
      expect(result.page.next_cursor).toBeNull();
    });

    it('reads a single invoice from staged lines', async () => {
      ledger.listStagedInvoiceLines.mockResolvedValue({
        lines: [
          { description: 'Processing fees', quantity: 1, unit_amount_minor: 1_200, amount_minor: 1_200 },
        ],
      } as never);

      const result = await resolver.get(TEST_MERCHANT_ID, 'inv_0001');

      expect(result.source).toBe('ledger');
      expect(ledger.listStagedInvoiceLines).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'inv_0001');
    });
  });

  it('the flag is the only thing that selects the arm', async () => {
    await resolver.list(TEST_MERCHANT_ID, {});
    expect(legacy.listInvoices).toHaveBeenCalledTimes(1);

    flags.set(FLAG_NAMES.LEDGER_OWNS_INVOICES, true);
    await resolver.list(TEST_MERCHANT_ID, {});

    expect(legacy.listInvoices).toHaveBeenCalledTimes(1);
    expect(ledger.listStagedInvoiceLines).toHaveBeenCalledTimes(1);
  });
});
