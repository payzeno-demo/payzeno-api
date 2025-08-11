import {
  TransportError,
  classifyTransportError,
  type HttpTransport,
  type TransportRequest,
} from 'src/api/transport.interface';
import { InMemoryTransport } from 'src/api/in-memory-transport';

/**
 * `InMemoryTransport` is dead code in production and load-bearing in the e2e suite: it is the
 * second `HttpTransport` implementation, and it is what lets `test/support/test-app.ts` boot a
 * real `LedgerHttpClient` — real retry policy, real `LedgerRejectedException` translation —
 * against no socket at all (blueprint §3.3).
 *
 * So it gets its own spec. A stub whose route matching is subtly wrong makes every e2e failure
 * point at the wrong file, and we have paid that tax once already (PAY-1918).
 */
describe('InMemoryTransport', () => {
  let transport: InMemoryTransport;

  function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
    return {
      method: 'GET',
      url: 'http://ledger.internal:8000/internal/v1/balances/mch_1',
      headers: { 'x-payzeno-service': 'payzeno-api' },
      body: null,
      connectTimeoutMs: 2_000,
      readTimeoutMs: 10_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    transport = new InMemoryTransport();
  });

  it('satisfies HttpTransport', () => {
    const asInterface: HttpTransport = transport;

    expect(asInterface.name).toBe('in-memory');
    expect(typeof asInterface.send).toBe('function');
  });

  describe('route matching', () => {
    it('matches a path template with a parameter segment', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({
        status: 200,
        body: { available_minor: 1_200 },
      }));

      const res = await transport.send(request());

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ available_minor: 1_200 });
    });

    it('ignores the query string when matching', async () => {
      transport.on('GET', '/internal/v1/transactions', () => ({ status: 200, body: { data: [] } }));

      const res = await transport.send(
        request({ url: 'http://ledger.internal:8000/internal/v1/transactions?merchant_id=mch_1&limit=50' }),
      );

      expect(res.status).toBe(200);
    });

    it('does not let a parameter segment swallow a slash', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {} }));

      await expect(
        transport.send(request({ url: 'http://ledger.internal:8000/internal/v1/balances/mch_1/history' })),
      ).rejects.toBeInstanceOf(TransportError);
    });

    it('discriminates on method', async () => {
      transport.on('POST', '/internal/v1/transactions', () => ({ status: 201, body: { id: 'txn_1' } }));

      await expect(
        transport.send(request({ method: 'GET', url: 'http://ledger.internal:8000/internal/v1/transactions' })),
      ).rejects.toThrow('no route for GET /internal/v1/transactions');

      const res = await transport.send(
        request({ method: 'POST', url: 'http://ledger.internal:8000/internal/v1/transactions', body: '{}' }),
      );
      expect(res.status).toBe(201);
    });

    it('accepts a RegExp for what a template cannot express', async () => {
      transport.on('GET', /^\/internal\/v1\/settlement-batches\/[^/]+\/items$/, () => ({
        status: 200,
        body: { data: [], has_more: false, next_cursor: null },
      }));

      const res = await transport.send(
        request({ url: 'http://ledger.internal:8000/internal/v1/settlement-batches/sb_QK/items?merchant_id=mch_1' }),
      );

      expect(res.status).toBe(200);
    });

    it('uses the first matching route so a spec can shadow the suite-wide stub', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: { tag: 'first' } }));
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: { tag: 'second' } }));

      const res = await transport.send(request());

      expect(JSON.parse(res.body)).toEqual({ tag: 'first' });
    });

    it('throws a network-kind TransportError for an unstubbed route', async () => {
      const err = await transport.send(request()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('network');
      expect((err as TransportError).url).toContain('/internal/v1/balances/mch_1');
    });
  });

  describe('responses', () => {
    it('serialises the stub body and defaults the content type', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: { currency: 'GBP' } }));

      const res = await transport.send(request());

      expect(res.headers['content-type']).toBe('application/json');
      expect(res.body).toBe('{"currency":"GBP"}');
    });

    it('lets a stub override headers — Retry-After is asserted by the idempotency e2e', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({
        status: 429,
        headers: { 'retry-after': '3' },
        body: { error: { code: 'rate_limited' } },
      }));

      const res = await transport.send(request());

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('3');
    });

    it('emits an empty body for a 204', async () => {
      transport.on('DELETE', '/tokens/:token', () => ({ status: 204 }));

      const res = await transport.send(
        request({ method: 'DELETE', url: 'https://vault.internal/tokens/tok_1' }),
      );

      expect(res.status).toBe(204);
      expect(res.body).toBe('');
    });

    it('supports an async handler', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', async () => {
        await Promise.resolve();
        return { status: 200, body: { async: true } };
      });

      await expect(transport.send(request())).resolves.toMatchObject({ status: 200 });
    });

    it('reports a duration that covers the simulated latency', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {}, delayMs: 25 }));

      const res = await transport.send(request());

      expect(res.durationMs).toBeGreaterThanOrEqual(20);
    });
  });

  describe('failOnce', () => {
    it('arms exactly one socket failure, then serves normally', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {} }));
      transport.failOnce(new TransportError('read_timeout', 'http://ledger.internal:8000', 'read timeout'));

      await expect(transport.send(request())).rejects.toMatchObject({ kind: 'read_timeout' });
      await expect(transport.send(request())).resolves.toMatchObject({ status: 200 });
    });

    it('records the failed attempt — retry counting depends on it', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {} }));
      transport.failOnce(new TransportError('connection_reset', 'http://ledger.internal:8000', 'ECONNRESET'));

      await transport.send(request()).catch(() => undefined);
      await transport.send(request());

      expect(transport.callsTo('GET', '/internal/v1/balances/:merchantId')).toHaveLength(2);
    });
  });

  describe('recording', () => {
    it('parses a JSON body so assertions read like the wire', async () => {
      transport.on('POST', '/internal/v1/accounts/bootstrap', () => ({ status: 201, body: { created: 4 } }));

      await transport.send(
        request({
          method: 'POST',
          url: 'http://ledger.internal:8000/internal/v1/accounts/bootstrap',
          body: JSON.stringify({ merchant_id: 'mch_1', currency: 'GBP', livemode: true }),
        }),
      );

      const [call] = transport.callsTo('POST', '/internal/v1/accounts/bootstrap');
      expect(call.body).toEqual({ merchant_id: 'mch_1', currency: 'GBP', livemode: true });
      expect(call.headers['x-payzeno-service']).toBe('payzeno-api');
    });

    it('keeps a non-JSON body verbatim', async () => {
      transport.on('POST', '/v1/processor/webhooks/:acquirer', () => ({ status: 202 }));

      await transport.send(
        request({ method: 'POST', url: 'https://api.payzeno.com/v1/processor/webhooks/worldflow', body: 'raw-payload' }),
      );

      expect(transport.callsTo('POST', '/v1/processor/webhooks/:acquirer')[0].body).toBe('raw-payload');
    });

    it('counts every call, matched or not', async () => {
      await transport.send(request()).catch(() => undefined);
      await transport.send(request()).catch(() => undefined);

      expect(transport.callCount).toBe(2);
    });

    it('reset clears routes, calls and the armed failure', async () => {
      transport.on('GET', '/internal/v1/balances/:merchantId', () => ({ status: 200, body: {} }));
      transport.failOnce(new TransportError('network', 'x', 'boom'));
      await transport.send(request()).catch(() => undefined);

      transport.reset();

      expect(transport.callCount).toBe(0);
      await expect(transport.send(request())).rejects.toThrow('no route for');
    });
  });

  describe('classifyTransportError', () => {
    it.each([
      ['UND_ERR_CONNECT_TIMEOUT', 'connect_timeout'],
      ['UND_ERR_HEADERS_TIMEOUT', 'read_timeout'],
      ['ECONNRESET', 'connection_reset'],
      ['ENOTFOUND', 'dns_failure'],
      ['ECONNREFUSED', 'network'],
    ])('maps %s onto %s', (code, kind) => {
      const err = classifyTransportError(Object.assign(new Error('socket'), { code }), 'http://ledger.internal');

      expect(err.kind).toBe(kind);
    });

    it('falls back to network for an unrecognised code', () => {
      expect(classifyTransportError(new Error('who knows'), 'http://ledger.internal').kind).toBe('network');
    });

    it('passes an existing TransportError through unchanged', () => {
      const original = new TransportError('read_timeout', 'http://ledger.internal', 'read timeout');

      expect(classifyTransportError(original, 'http://ledger.internal')).toBe(original);
    });

    it('only claims non-delivery for failures that never opened a socket', () => {
      expect(classifyTransportError(Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }), 'u')
        .definitelyNotDelivered).toBe(true);
      // A read timeout means the ledger probably got it. Replaying a POST on one of these is
      // how you post a settlement twice — api-surface.md §11.
      expect(classifyTransportError(Object.assign(new Error(''), { code: 'UND_ERR_BODY_TIMEOUT' }), 'u')
        .definitelyNotDelivered).toBe(false);
    });
  });
});
