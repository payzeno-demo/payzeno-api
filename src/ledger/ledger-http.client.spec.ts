import { DEFAULT_CLIENT_OPTIONS } from 'src/api/client';
import { InMemoryTransport } from 'src/api/in-memory-transport';
import { IdempotentRetryPolicy } from 'src/api/retry.policy';
import { TransportError } from 'src/api/transport.interface';
import {
  LedgerRejectedException,
  LedgerUnavailableException,
} from 'src/common/errors/upstream.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import { LedgerHttpClient } from 'src/ledger/ledger-http.client';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The client every one of payzeno-api's 14 ledger calls goes through.
 *
 * Two rules, and both of them exist because of arc INC:
 *
 *  1. **`LedgerRejectedException` is a passthrough.** Any non-2xx with a parseable
 *     `ApiError` becomes it, carrying the ledger's `code`, `httpStatus` and `details`
 *     verbatim. That is what gives `settlement_locked` a route to the console instead of
 *     a generic 502 — and after PAY-2043 a locked item is the *ordinary* outcome of
 *     racing a sweep, not an incident.
 *  2. **`LedgerUnavailableException` is transport-only** — connect/read timeout, reset,
 *     or a 5xx with no parseable body.
 */
describe('LedgerHttpClient', () => {
  let transport: InMemoryTransport;
  let client: LedgerHttpClient;

  function build(retries = 2): LedgerHttpClient {
    return new LedgerHttpClient(
      { baseUrl: 'http://ledger.test', internalSecret: 'test-internal-secret' },
      transport,
      { ...DEFAULT_CLIENT_OPTIONS, retries },
      new IdempotentRetryPolicy(retries + 1, 1, 0),
      new NoopLogger(),
    );
  }

  function apiError(code: string, message = 'nope', details?: Record<string, unknown>) {
    return { error: { code, message, request_id: 'req_ledger_1', details } };
  }

  beforeEach(() => {
    transport = new InMemoryTransport();
    client = build();
  });

  describe('authentication', () => {
    it('sends the internal service headers on every call', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {} }));

      await client.getBalance(TEST_MERCHANT_ID);

      const [call] = transport.callsTo('GET', '/internal/v1/balances/:merchantId');
      expect(call.headers['x-payzeno-service']).toBe('payzeno-api');
      expect(call.headers['x-payzeno-internal-secret']).toBe('test-internal-secret');
    });
  });

  describe('routes', () => {
    it('retries a settlement item at the reconciliation route', async () => {
      transport.on('POST', '/internal/v1/reconciliation/items/:itemId/retry', () => ({
        status: 202,
        body: { id: 'ri_000042' },
      }));

      await client.retryReconciliationItem('ri_000042', { reason: 'operator' } as never);

      expect(transport.callsTo('POST', /\/reconciliation\/items\/[^/]+\/retry$/)[0].path).toBe(
        '/internal/v1/reconciliation/items/ri_000042/retry',
      );
    });
  });

  describe('error translation', () => {
    it('does not collapse a 422 into a 502', async () => {
      transport.on('POST', '/internal/v1/reconciliation/items/:itemId/retry', () => ({
        status: 422,
        body: apiError('batch_not_reconcilable', 'batch is still open'),
      }));

      await expect(
        client.retryReconciliationItem('ri_1', { reason: 'x' } as never),
      ).rejects.toMatchObject({ status: 422, code: 'batch_not_reconcilable' });
    });

    it.each([
      'duplicate_settlement',
      'payout_blocked',
      'account_frozen',
      'ledger_imbalance',
    ])('passes %s through as its own code', async (code) => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({
        status: 409,
        body: apiError(code),
      }));

      await expect(client.getBalance(TEST_MERCHANT_ID)).rejects.toMatchObject({ code });
    });

    it('retries a 503 on a GET', async () => {
      let calls = 0;
      transport.on('GET', '/internal/v1/balances/:merchantId', () => {
        calls += 1;
        return calls < 2 ? { status: 503, body: {} } : { status: 200, body: { object: 'balance' } };
      });

      await expect(client.getBalance(TEST_MERCHANT_ID)).resolves.toMatchObject({
        object: 'balance',
      });
      expect(calls).toBe(2);
    });

    it('retries a read timeout — the case a status-only predicate never fires on', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({
        status: 200,
        body: { object: 'balance' },
      }));
      transport.failOnce(new TransportError('read_timeout', 'http://ledger.test/x', 'read timeout'));

      await expect(client.getBalance(TEST_MERCHANT_ID)).resolves.toBeDefined();
    });

  });
});
