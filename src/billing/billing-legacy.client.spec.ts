import { CircuitBreakerRegistry } from 'src/api/circuit-breaker';
import { DEFAULT_CLIENT_OPTIONS } from 'src/api/client';
import { InMemoryTransport } from 'src/api/in-memory-transport';
import { NoRetryPolicy } from 'src/api/retry.policy';
import { TransportError } from 'src/api/transport.interface';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { LegacyBillingUnavailableException } from 'src/common/errors/upstream.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import { BillingLegacyClient } from 'src/billing/billing-legacy.client';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The Java service, behind an opossum breaker.
 *
 * Three of these methods are `@Deprecated` on the far side and log
 * `LEGACY_CALL_AFTER_MIGRATION` on this one. That log line is the arc-MIG progress metric:
 * when it stops appearing, `generateInvoice` / `computeFees` / `getStatement` can go.
 */
describe('BillingLegacyClient', () => {
  let transport: InMemoryTransport;
  let breakers: CircuitBreakerRegistry;
  let logger: NoopLogger;
  let client: BillingLegacyClient;

  const invoice = { id: 'inv_0001', object: 'invoice', merchant_id: TEST_MERCHANT_ID };

  beforeEach(() => {
    transport = new InMemoryTransport();
    breakers = new CircuitBreakerRegistry();
    logger = new NoopLogger();
    jest.spyOn(logger, 'warn');
    client = new BillingLegacyClient(
      {
        baseUrl: 'http://billing.test',
        user: 'payzeno-api',
        password: 'secret',
        // api-surface.md §13: 50% over a 20-request window, 30s reset.
        breakerErrorThresholdPercent: 50,
        breakerVolumeThreshold: 20,
        breakerResetTimeoutMs: 30_000,
      },
      transport,
      { ...DEFAULT_CLIENT_OPTIONS, retries: 0 },
      new NoRetryPolicy(),
      logger,
      breakers,
    );
  });

  describe('the live surface', () => {
    it('lists invoices scoped to the merchant', async () => {
      transport.on('GET', '/internal/v1/invoices', () => ({
        status: 200,
        body: { data: [invoice], next_cursor: null, has_more: false },
      }));

      await expect(client.listInvoices(TEST_MERCHANT_ID, { status: 'open' })).resolves.toMatchObject({
        data: [invoice],
      });

      const { url } = transport.callsTo('GET', '/internal/v1/invoices')[0];
      expect(url).toContain(`merchant_id=${TEST_MERCHANT_ID}`);
      expect(url).toContain('status=open');
    });

    it('authenticates with HTTP basic, not a bearer', async () => {
      transport.on('GET', '/internal/v1/invoices', () => ({
        status: 200,
        body: { data: [], next_cursor: null, has_more: false },
      }));

      await client.listInvoices(TEST_MERCHANT_ID);

      const { headers } = transport.callsTo('GET', '/internal/v1/invoices')[0];
      expect(headers.authorization).toBe(
        `Basic ${Buffer.from('payzeno-api:secret').toString('base64')}`,
      );
    });

    it('gets one invoice by id', async () => {
      transport.on('GET', '/internal/v1/invoices/:id', () => ({ status: 200, body: invoice }));

      await expect(client.getInvoice('inv_0001')).resolves.toMatchObject({ id: 'inv_0001' });
    });

    it('voids an invoice with a deterministic idempotency key', async () => {
      transport.on('POST', '/internal/v1/invoices/:id/void', () => ({
        status: 200,
        body: { ...invoice, status: 'void' },
      }));

      await client.voidInvoice('inv_0001');

      expect(transport.callsTo('POST', /\/void$/)[0].headers['idempotency-key']).toBe(
        'invoice_void:inv_0001',
      );
    });

    it('does not log LEGACY_CALL_AFTER_MIGRATION on the live surface', async () => {
      transport.on('GET', '/internal/v1/invoices', () => ({
        status: 200,
        body: { data: [], next_cursor: null, has_more: false },
      }));

      await client.listInvoices(TEST_MERCHANT_ID);

      expect(logger.warn).not.toHaveBeenCalledWith(
        'LEGACY_CALL_AFTER_MIGRATION',
        expect.anything(),
      );
    });
  });

  describe('the deprecated surface (arc MIG)', () => {
    it('logs LEGACY_CALL_AFTER_MIGRATION for generateInvoice', async () => {
      transport.on('POST', '/internal/v1/invoices', () => ({ status: 201, body: invoice }));

      await client.generateInvoice({
        merchant_id: TEST_MERCHANT_ID,
        period_start: '2026-01-01',
        period_end: '2026-01-31',
      } as never);

      expect(logger.warn).toHaveBeenCalledWith(
        'LEGACY_CALL_AFTER_MIGRATION',
        expect.objectContaining({ method: 'generateInvoice', merchant_id: TEST_MERCHANT_ID }),
      );
    });

    it('logs LEGACY_CALL_AFTER_MIGRATION for computeFees', async () => {
      transport.on('POST', '/internal/v1/fees/compute', () => ({ status: 200, body: {} }));

      await client.computeFees({ merchant_id: TEST_MERCHANT_ID } as never);

      expect(logger.warn).toHaveBeenCalledWith(
        'LEGACY_CALL_AFTER_MIGRATION',
        expect.objectContaining({ method: 'computeFees' }),
      );
    });

    it('logs LEGACY_CALL_AFTER_MIGRATION for getStatement', async () => {
      transport.on('GET', '/internal/v1/statements', () => ({ status: 200, body: {} }));

      await client.getStatement(TEST_MERCHANT_ID, '2026-01');

      expect(logger.warn).toHaveBeenCalledWith(
        'LEGACY_CALL_AFTER_MIGRATION',
        expect.objectContaining({ method: 'getStatement' }),
      );
    });

    it('names payzeno-billing-legacy as the upstream in the warning', async () => {
      transport.on('GET', '/internal/v1/statements', () => ({ status: 200, body: {} }));

      await client.getStatement(TEST_MERCHANT_ID, '2026-01');

      expect(logger.warn).toHaveBeenCalledWith(
        'LEGACY_CALL_AFTER_MIGRATION',
        expect.objectContaining({ upstream: 'payzeno-billing-legacy' }),
      );
    });
  });

  describe('error translation', () => {
    it('maps a 404 to ResourceNotFoundException, not to a 502', async () => {
      transport.on('GET', '/internal/v1/invoices/:id', () => ({ status: 404, body: {} }));

      await expect(client.getInvoice('inv_missing')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('maps every other non-2xx to LegacyBillingUnavailableException', async () => {
      transport.on('GET', '/internal/v1/invoices/:id', () => ({ status: 500, body: 'stack trace' }));

      await expect(client.getInvoice('inv_0001')).rejects.toBeInstanceOf(
        LegacyBillingUnavailableException,
      );
    });

    it('maps a socket failure to LegacyBillingUnavailableException', async () => {
      transport.on('GET', '/internal/v1/invoices/:id', () => ({ status: 200, body: invoice }));
      transport.failOnce(
        new TransportError('read_timeout', 'http://billing.test/internal/v1/invoices/x', 'timeout'),
      );

      await expect(client.getInvoice('inv_0001')).rejects.toBeInstanceOf(
        LegacyBillingUnavailableException,
      );
    });
  });

  describe('the circuit breaker', () => {
    it('runs every call under one named circuit', async () => {
      transport.on('GET', '/internal/v1/invoices', () => ({
        status: 200,
        body: { data: [], next_cursor: null, has_more: false },
      }));

      await client.listInvoices(TEST_MERCHANT_ID);
      await client.listInvoices(TEST_MERCHANT_ID);

      expect(breakers.snapshot()).toHaveLength(1);
    });

    it('trips and short-circuits with LegacyBillingUnavailableException', async () => {
      transport.on('GET', '/internal/v1/invoices', () => ({ status: 500, body: 'boom' }));

      for (let i = 0; i < 25; i += 1) {
        await client.listInvoices(TEST_MERCHANT_ID).catch(() => undefined);
      }

      const callsBefore = transport.callCount;
      await expect(client.listInvoices(TEST_MERCHANT_ID)).rejects.toBeInstanceOf(
        LegacyBillingUnavailableException,
      );

      // Once open, the Java service is not touched at all — that is the 40 minutes the
      // month-4 outage cost before the registry existed.
      expect(transport.callCount).toBe(callsBefore);
    });
  });
});
