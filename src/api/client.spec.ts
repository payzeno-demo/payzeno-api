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

    it('encodes query parameters and drops undefined ones', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: {} }));

      await client.call({
        method: 'GET',
        path: '/v1/thing',
        query: { limit: 10, status: 'settled', cursor: undefined },
      });

      const { url } = transport.callsTo('GET', '/v1/thing')[0];
      expect(url).toContain('limit=10');
      expect(url).toContain('status=settled');
      expect(url).not.toContain('cursor');
    });

    it('merges default headers under per-request headers', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: {} }));

      await client.call({ method: 'GET', path: '/v1/thing', headers: { 'x-extra': '1' } });

      const { headers } = transport.callsTo('GET', '/v1/thing')[0];
      expect(headers.authorization).toBe('Bearer test-token');
      expect(headers['x-extra']).toBe('1');
      expect(headers.accept).toBe('application/json');
    });

    it('serialises a body and sets the content type', async () => {
      transport.on('POST', '/v1/thing', () => ({ status: 201, body: { id: 'x' } }));

      await client.call({ method: 'POST', path: '/v1/thing', body: { amount_minor: 4_500 } });

      const call = transport.callsTo('POST', '/v1/thing')[0];
      expect(call.body).toEqual({ amount_minor: 4_500 });
      expect(call.headers['content-type']).toBe('application/json');
    });

    it('never sends a body on a GET', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: {} }));

      await client.call({ method: 'GET', path: '/v1/thing', body: { nope: true } });

      expect(transport.callsTo('GET', '/v1/thing')[0].body).toBeNull();
    });

    it('forwards the idempotency key as a header', async () => {
      transport.on('POST', '/v1/thing', () => ({ status: 201, body: {} }));

      await client.call({ method: 'POST', path: '/v1/thing', body: {}, idempotencyKey: 'k1' });

      expect(transport.callsTo('POST', '/v1/thing')[0].headers['idempotency-key']).toBe('k1');
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

    it('lets a per-request timeout override the default read timeout', async () => {
      transport.on('GET', '/v1/slow', () => ({ status: 200, body: {} }));

      await client.call({ method: 'GET', path: '/v1/slow', timeoutMs: 30_000 });

      expect(transport.callCount).toBe(1);
    });
  });

  describe('responses', () => {
    it('parses a JSON body', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 200, body: { id: 'x', n: 1 } }));

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).resolves.toEqual({
        id: 'x',
        n: 1,
      });
    });

    it('tolerates an empty 204 body', async () => {
      transport.on('DELETE', '/v1/thing', () => ({ status: 204 }));

      await expect(client.call({ method: 'DELETE', path: '/v1/thing' })).resolves.toBeDefined();
    });
  });

  describe('failure translation', () => {
    it('routes a non-2xx to mapUpstreamFailure with the parsed ApiError', async () => {
      transport.on('POST', '/v1/thing', () => ({
        status: 409,
        body: {
          error: { code: 'settlement_locked', message: 'locked', request_id: 'req_up_1' },
        },
      }));

      try {
        await client.call({ method: 'POST', path: '/v1/thing', body: {} });
        throw new Error('expected a rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(UpstreamAnsweredError);
        const failure = (err as UpstreamAnsweredError).failure;
        expect(failure.status).toBe(409);
        expect(failure.apiError?.error.code).toBe('settlement_locked');
      }
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

    it('routes a socket failure to mapTransportFailure, never to mapUpstreamFailure', async () => {
      const noRetry = new TestClient(transport, 0);
      transport.on('POST', '/v1/thing', () => ({ status: 200, body: {} }));
      transport.failOnce(new TransportError('connection_reset', 'http://upstream.test/v1/thing', 'ECONNRESET'));

      await expect(
        noRetry.call({ method: 'POST', path: '/v1/thing', body: {} }),
      ).rejects.toBeInstanceOf(TransportBrokeError);
    });
  });

  describe('retries', () => {
    it('retries a 503 on a GET and returns the eventual success', async () => {
      let calls = 0;
      transport.on('GET', '/v1/thing', () => {
        calls += 1;
        return calls < 3 ? { status: 503, body: {} } : { status: 200, body: { ok: true } };
      });

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).resolves.toEqual({ ok: true });
      expect(calls).toBe(3);
    });

    it('gives up after the retry budget and translates the last response', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 503, body: {} }));

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).rejects.toBeInstanceOf(
        UpstreamAnsweredError,
      );
      expect(transport.callCount).toBe(3);
    });

    it('does not retry a 4xx', async () => {
      transport.on('GET', '/v1/thing', () => ({ status: 404, body: {} }));

      await expect(client.call({ method: 'GET', path: '/v1/thing' })).rejects.toThrow();
      expect(transport.callCount).toBe(1);
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
