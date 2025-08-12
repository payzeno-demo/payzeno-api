import { RequestIdMiddleware, sanitise } from 'src/common/middleware/request-id.middleware';
import { currentRequestId, getRequestContext } from 'src/common/logging/request-context';

/**
 * First link in the chain. Everything downstream — the logger, the audit interceptor, the
 * outbox publisher, `HttpExceptionFilter` — assumes a request context exists, so the one
 * behaviour that must never regress is that `next()` runs *inside* the ALS scope.
 */
describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let headers: Record<string, string>;
  let res: { headers: Record<string, string>; setHeader: jest.Mock };

  function req(overrides: Record<string, unknown> = {}) {
    return { method: 'POST', url: '/v1/charges', headers, ...overrides };
  }

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
    headers = {};
    res = {
      headers: {},
      setHeader: jest.fn((name: string, value: string) => {
        res.headers[name.toLowerCase()] = value;
      }),
    };
  });

  it('mints a request id when the caller sends none', () => {
    let seen = '';
    middleware.use(req(), res, () => {
      seen = currentRequestId();
    });

    expect(seen).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(seen);
  });

  it('echoes a caller-supplied id', () => {
    headers['x-request-id'] = 'req_from_console_0001';

    let seen = '';
    middleware.use(req(), res, () => {
      seen = currentRequestId();
    });

    expect(seen).toBe('req_from_console_0001');
    expect(res.headers['x-request-id']).toBe('req_from_console_0001');
  });

  it('opens the context before calling next()', () => {
    let context: ReturnType<typeof getRequestContext>;
    middleware.use(req(), res, () => {
      context = getRequestContext();
    });

    expect(context).toBeDefined();
    expect(context?.method).toBe('POST');
  });

  it('seeds correlationId from the request id — CorrelationIdMiddleware overwrites it', () => {
    middleware.use(req(), res, () => {
      const context = getRequestContext();
      expect(context?.correlationId).toBe(context?.requestId);
    });
  });

  it('records the path, preferring originalUrl', () => {
    middleware.use(req({ originalUrl: '/v1/charges?limit=10' }), res, () => {
      expect(getRequestContext()?.path).toBe('/v1/charges?limit=10');
    });
  });

  it('starts with no principal and livemode false', () => {
    middleware.use(req(), res, () => {
      const context = getRequestContext();
      expect(context?.principal).toBeNull();
      expect(context?.merchantId).toBeNull();
      expect(context?.livemode).toBe(false);
    });
  });

  it('stamps a start time so the access log can measure duration', () => {
    middleware.use(req(), res, () => {
      expect(getRequestContext()?.startedAtMs).toBeGreaterThan(0);
    });
  });

  it('does not leak the context out of the callback', () => {
    middleware.use(req(), res, () => undefined);

    expect(getRequestContext()).toBeUndefined();
  });

  it('gives concurrent requests distinct ids', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      middleware.use(req(), res, () => ids.push(currentRequestId()));
    }

    expect(new Set(ids).size).toBe(5);
  });
});

describe('sanitise', () => {
  it('accepts a safe id', () => {
    expect(sanitise('req_abc-123.4')).toBe('req_abc-123.4');
  });

  it('takes the first value of a repeated header', () => {
    expect(sanitise(['first', 'second'])).toBe('first');
  });

  it('returns null for undefined and empty', () => {
    expect(sanitise(undefined)).toBeNull();
    expect(sanitise('')).toBeNull();
  });

  it('rejects a header with characters that would break a log line', () => {
    // A caller correlating its own traces is the point; a caller injecting a newline
    // into every structured log line is not.
    expect(sanitise('req_1\nINJECTED')).toBeNull();
    expect(sanitise('req 1')).toBeNull();
    expect(sanitise('req_<script>')).toBeNull();
  });

  it('truncates an over-long id rather than rejecting it outright', () => {
    const long = 'a'.repeat(200);

    expect(sanitise(long)).toHaveLength(128);
  });

  it('rejects an over-long id whose truncation is still unsafe', () => {
    expect(sanitise(`${'a'.repeat(120)} spaces here`)).toBeNull();
  });
});
