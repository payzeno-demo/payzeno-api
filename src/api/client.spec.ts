import {
  BaseHttpClient,
  DEFAULT_CLIENT_OPTIONS,
  type RequestSpec,
  type UpstreamFailure,
} from 'src/api/client';
import { InMemoryTransport } from 'src/api/in-memory-transport';
import { IdempotentRetryPolicy, NoRetryPolicy } from 'src/api/retry.policy';
import { TransportError } from 'src/api/transport.interface';
import { NoopLogger } from 'src/common/logging/logger';
import { RequestIdMiddleware } from 'src/common/middleware/request-id.middleware';
import { CorrelationIdMiddleware } from 'src/common/middleware/correlation-id.middleware';

/**
 * `BaseHttpClient` — L2, the spine every cross-repo `HTTP_CALLS` edge in this repo shares.
 *
 * It owns policy (timeouts, retries, error translation, header propagation) and no
 * sockets. The two failure paths are deliberately separate: `mapUpstreamFailure` for "the
 * upstream answered and said no", `mapTransportFailure` for "the socket broke". Collapsing
 * them is how a `409 settlement_locked` becomes a generic 502.
 */

class UpstreamAnsweredError extends Error {
  constructor(readonly failure: UpstreamFailure) {
    super(`upstream ${failure.status}`);
  }
}

class TransportBrokeError extends Error {
  constructor(readonly kind: string) {
    super(`transport ${kind}`);
  }
}

class TestClient extends BaseHttpClient {
  constructor(
    transport: InMemoryTransport,
    retries = 2,
    private readonly base = 'http://upstream.test',
  ) {
    super(
      transport,
      { ...DEFAULT_CLIENT_OPTIONS, retries },
      retries === 0 ? new NoRetryPolicy() : new IdempotentRetryPolicy(retries + 1, 1, 0),
      new NoopLogger(),
    );
  }

  protected get baseUrl(): string {
    return this.base;
  }

  protected get upstream(): string {
    return 'test-upstream';
  }

  protected defaultHeaders(): Record<string, string> {
    return { authorization: 'Bearer test-token' };
  }

  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    throw new UpstreamAnsweredError(failure);
  }

  protected mapTransportFailure(err: TransportError): never {
    throw new TransportBrokeError(err.kind);
  }

  call<T>(spec: RequestSpec<unknown>): Promise<T> {
    return this.request<T>(spec);
  }
}

describe('BaseHttpClient', () => {
  let transport: InMemoryTransport;
  let client: TestClient;

  beforeEach(() => {
    transport = new InMemoryTransport();
    client = new TestClient(transport);
  });

  describe('request building', () => {
    it('joins the base url and the path', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: { ok: true } }));

      await client.call({ method: 'GET', path: '/v1/thing' });

      expect(transport.callsTo('GET', '/v1/thing')[0].url).toBe('http://upstream.test/v1/thing');
    });

    it('serialises a body and sets the content type', async () => {
      transport.on('POST', '/v1/thing', () => ({ status: 201, body: { id: 'x' } }));

      await client.call({ method: 'POST', path: '/v1/thing', body: { amount_minor: 4_500 } });

      const call = transport.callsTo('POST', '/v1/thing')[0];
      expect(call.body).toEqual({ amount_minor: 4_500 });
      expect(call.headers['content-type']).toBe('application/json');
    });

    it('propagates the request and correlation ids from the ambient context', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: {} }));

      const requestId = new RequestIdMiddleware();
      const correlation = new CorrelationIdMiddleware();
      const res = { setHeader: () => undefined };
      const headers = { 'x-correlation-id': 'corr_console_0001' };

      await new Promise<void>((resolve) => {
        requestId.use({ method: 'GET', url: '/v1/x', headers }, res, () => {
          correlation.use({ headers }, res, () => {
            void client.call({ method: 'GET', path: '/v1/thing' }).then(() => resolve());
          });
        });
      });

      // events.ts requires correlation_id to be carried from the originating request; this
      // header is where that propagation actually happens.
      const sent = transport.callsTo('GET', '/v1/thing')[0].headers;
      expect(sent['x-correlation-id']).toBe('corr_console_0001');
      expect(sent['x-request-id']).toMatch(/^req_/);
    });

    it('parses a JSON body', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: { id: 'x', n: 1 } }));

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).resolves.toEqual({
        id: 'x',
        n: 1,
      });
    });

    it('reports a null apiError when the body is not an envelope', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 500, body: '<html>oops</html>' }));

      try {
        await client.call({ method: 'GET', path: '/v1/thing' });
        throw new Error('expected a rejection');
      } catch (err) {
        expect((err as UpstreamAnsweredError).failure.apiError).toBeNull();
      }
    });

    it('retries a 503 on a GET and returns the eventual success', async () => {
      let calls = 0;
      transport.on('GET', '/v1/thing', () => {
        calls += 1;
        return calls < 3 ? { status: 503, body: {} } : { status: 200, body: { ok: true } };
      });

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).resolves.toEqual({ ok: true });
      expect(calls).toBe(3);
    });

    it('does not retry an unkeyed POST', async () => {
      transport.on('POST', '/v1/thing', () => ({ status: 503, body: {} }));

      await expect(client.call({ method: 'POST', path: '/v1/thing', body: {} })).rejects.toThrow();
      expect(transport.callCount).toBe(1);
    });

    it('retries a keyed POST', async () => {
      transport.on('POST', '/v1/thing', () => ({ status: 503, body: {} }));

      await expect(
        client.call({ method: 'POST', path: '/v1/thing', body: {}, idempotencyKey: 'k1' }),
      ).rejects.toThrow();
      expect(transport.callCount).toBe(3);
    });

    it('retries a one-shot socket failure', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: { ok: true } }));
      transport.failOnce(new TransportError('read_timeout', 'http://upstream.test/v1/thing', 'timeout'));

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).resolves.toEqual({ ok: true });
    });
  });
});
