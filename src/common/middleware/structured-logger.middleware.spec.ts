import { NoopLogger } from 'src/common/logging/logger';
import { RequestIdMiddleware } from 'src/common/middleware/request-id.middleware';
import { StructuredLoggerMiddleware } from 'src/common/middleware/structured-logger.middleware';
import { attachPrincipal } from 'src/common/logging/request-context';

import { makeApiKeyPrincipal, makeSessionPrincipal } from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * One structured line per request, on the way out.
 *
 * Deliberately nothing on the way in: a line at request start doubles the log volume and
 * says nothing the completion line does not. The slow-request warn is the number the
 * latency alarm in payzeno-infrastructure is set against, so its threshold is asserted.
 */
describe('StructuredLoggerMiddleware', () => {
  let logger: NoopLogger;
  let middleware: StructuredLoggerMiddleware;
  let finish: (() => void) | null;

  function res(statusCode = 200) {
    finish = null;
    return {
      statusCode,
      on: (_event: 'finish', listener: () => void) => {
        finish = listener;
      },
    };
  }

  beforeEach(() => {
    logger = new NoopLogger();
    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'error');
    middleware = new StructuredLoggerMiddleware(logger);
  });

  it('logs nothing until the response finishes', () => {
    middleware.use({ method: 'GET', url: '/v1/charges' }, res(), () => undefined);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs one info line on a 2xx', () => {
    const response = res(200);
    middleware.use({ method: 'GET', url: '/v1/charges' }, response, () => undefined);

    finish!();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ method: 'GET', path: '/v1/charges', status: 200 }),
    );
  });

  it('prefers originalUrl for the path', () => {
    const response = res(200);
    middleware.use(
      { method: 'GET', url: '/v1/charges', originalUrl: '/v1/charges?limit=10' },
      response,
      () => undefined,
    );

    finish!();

    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ path: '/v1/charges?limit=10' }),
    );
  });

  it('logs an error line on a 5xx', () => {
    const response = res(500);
    middleware.use({ method: 'POST', url: '/v1/refunds' }, response, () => undefined);

    finish!();

    expect(logger.error).toHaveBeenCalledWith('request failed', undefined, expect.anything());
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs an info line, not an error, on a 4xx', () => {
    const response = res(404);
    middleware.use({ method: 'GET', url: '/v1/charges/ch_x' }, response, () => undefined);

    finish!();

    // A merchant asking for a charge that is not theirs is not an operational event.
    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports anonymous when no principal was attached', () => {
    const response = res(200);
    middleware.use({ method: 'GET', url: '/healthz' }, response, () => undefined);

    finish!();

    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ principal_kind: 'anonymous', merchant_id: null }),
    );
  });

  it('picks up the merchant and principal kind from the request context', () => {
    const requestId = new RequestIdMiddleware();
    const response = res(200);

    requestId.use(
      { method: 'POST', url: '/v1/refunds', headers: {} },
      { setHeader: () => undefined },
      () => {
        attachPrincipal(makeApiKeyPrincipal({ merchant_id: TEST_MERCHANT_ID }));
        middleware.use({ method: 'POST', url: '/v1/refunds' }, response, () => undefined);
        finish!();
      },
    );

    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        merchant_id: TEST_MERCHANT_ID,
        principal_kind: 'api_key',
        livemode: true,
      }),
    );
  });

  it('reports livemode false for a test-mode key', () => {
    const requestId = new RequestIdMiddleware();
    const response = res(200);

    requestId.use(
      { method: 'GET', url: '/v1/charges', headers: {} },
      { setHeader: () => undefined },
      () => {
        attachPrincipal(makeApiKeyPrincipal({ mode: 'test' }));
        middleware.use({ method: 'GET', url: '/v1/charges' }, response, () => undefined);
        finish!();
      },
    );

    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ livemode: false }),
    );
  });

  it('reports a dashboard session principal', () => {
    const requestId = new RequestIdMiddleware();
    const response = res(200);

    requestId.use(
      { method: 'GET', url: '/v1/auth/me', headers: {} },
      { setHeader: () => undefined },
      () => {
        attachPrincipal(makeSessionPrincipal());
        middleware.use({ method: 'GET', url: '/v1/auth/me' }, response, () => undefined);
        finish!();
      },
    );

    expect(logger.info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ principal_kind: 'dashboard_session' }),
    );
  });

  it('records a duration', () => {
    const response = res(200);
    middleware.use({ method: 'GET', url: '/v1/charges' }, response, () => undefined);

    finish!();

    const [, line] = (logger.info as jest.Mock).mock.calls[0];
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('never logs a request body', () => {
    const response = res(200);
    middleware.use(
      { method: 'POST', url: '/v1/bank-accounts', body: { account_number: '00012345' } } as never,
      response,
      () => undefined,
    );

    finish!();

    // RedactionInterceptor runs AFTER this middleware, so anything logged from req.body
    // here would be pre-redaction.
    const [, line] = (logger.info as jest.Mock).mock.calls[0];
    expect(JSON.stringify(line)).not.toContain('00012345');
    expect(line).not.toHaveProperty('body');
  });

  it('always calls next()', () => {
    const next = jest.fn();

    middleware.use({ method: 'GET', url: '/v1/charges' }, res(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
