import { CorrelationIdMiddleware } from 'src/common/middleware/correlation-id.middleware';
import { RequestIdMiddleware } from 'src/common/middleware/request-id.middleware';
import { currentCorrelationId, getRequestContext } from 'src/common/logging/request-context';

/**
 * The whole propagation mechanism for `EventEnvelope.correlation_id`.
 *
 * events.ts requires the field to be carried from the originating HTTP request, and this
 * is the only place it is seeded. Console → api → ledger → bus → merchant webhook is one
 * id across five hops and three runtimes; if this middleware minted a fresh value the
 * postmortem timeline for arc INC would not exist.
 */
describe('CorrelationIdMiddleware', () => {
  const requestId = new RequestIdMiddleware();
  const middleware = new CorrelationIdMiddleware();

  function res() {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    };
  }

  /** Runs both middlewares in chain order, exactly as `app.module.ts` configures them. */
  function chain(headers: Record<string, string>, fn: () => void): Record<string, string> {
    const response = res();
    requestId.use({ method: 'POST', url: '/v1/charges', headers }, response, () => {
      middleware.use({ headers }, response, fn);
    });
    return response.headers;
  }

  it('adopts a caller-supplied correlation id', () => {
    let seen = '';
    chain({ 'x-correlation-id': 'corr_console_0001' }, () => {
      seen = currentCorrelationId();
    });

    expect(seen).toBe('corr_console_0001');
  });

  it('echoes the correlation id on the response', () => {
    const headers = chain({ 'x-correlation-id': 'corr_console_0001' }, () => undefined);

    expect(headers['x-correlation-id']).toBe('corr_console_0001');
  });

  it('falls back to the request id, never to a fresh value', () => {
    let correlation = '';
    let request = '';
    chain({}, () => {
      correlation = currentCorrelationId();
      request = getRequestContext()!.requestId;
    });

    // Two different ids for one request is worse than one id repeated.
    expect(correlation).toBe(request);
  });

  it('rejects an unsafe inbound value and falls back', () => {
    let correlation = '';
    let request = '';
    chain({ 'x-correlation-id': 'corr\ninjected' }, () => {
      correlation = currentCorrelationId();
      request = getRequestContext()!.requestId;
    });

    expect(correlation).toBe(request);
  });

  it('does not overwrite the request id itself', () => {
    let request = '';
    chain({ 'x-correlation-id': 'corr_console_0001' }, () => {
      request = getRequestContext()!.requestId;
    });

    expect(request).not.toBe('corr_console_0001');
  });

  it('is a no-op outside a request context rather than throwing', () => {
    const response = res();

    expect(() =>
      middleware.use({ headers: { 'x-correlation-id': 'corr_1' } }, response, () => undefined),
    ).not.toThrow();
  });

  it('always calls next(), context or not', () => {
    const next = jest.fn();

    middleware.use({ headers: {} }, res(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps the same correlation id for the whole request', () => {
    const seen: string[] = [];
    chain({ 'x-correlation-id': 'corr_console_0001' }, () => {
      seen.push(currentCorrelationId());
      seen.push(currentCorrelationId());
    });

    expect(new Set(seen).size).toBe(1);
  });
});
