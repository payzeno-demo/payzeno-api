import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { AUDIT_LOG_KEY } from 'src/common/decorators/audit-log.decorator';
import { AuditLogInterceptor } from 'src/common/interceptors/audit-log.interceptor';
import type { AuditSink } from 'src/common/interceptors/audit-log.interceptor';
import { NoopLogger } from 'src/common/logging/logger';
import { RequestIdMiddleware } from 'src/common/middleware/request-id.middleware';
import { attachPrincipal } from 'src/common/logging/request-context';

import {
  makeApiKeyPrincipal,
  makeSessionPrincipal,
  makeStaffPrincipal,
} from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The `audit_log` / `staff_audit_log` writer, driven by `@AuditLog(action)` on 22 mutating
 * handlers.
 *
 * The split matters: a staff action goes to `staff_audit_log` with the operator's id and
 * their stated reason, a merchant action goes to `audit_log` with the merchant's actor.
 * Writing a staff suspension into the merchant's own audit trail would make it look, to
 * the merchant, as though they did it.
 */
describe('AuditLogInterceptor', () => {
  let reflector: Reflector;
  let sink: jest.Mocked<AuditSink>;
  let logger: NoopLogger;
  let interceptor: AuditLogInterceptor;

  function context(
    principal: unknown,
    spec: unknown = { action: 'merchant.create' },
    request: Record<string, unknown> = {},
  ): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(spec);
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ ip: '203.0.113.7', params: {}, body: {}, principal, ...request }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function handler(body: unknown = { id: 'mch_1' }): CallHandler {
    return { handle: () => of(body) };
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    reflector = new Reflector();
    sink = {
      record: jest.fn().mockResolvedValue(undefined),
      recordStaff: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditSink>;
    logger = new NoopLogger();
    jest.spyOn(logger, 'error');
    interceptor = new AuditLogInterceptor(reflector, logger, sink);
  });

  it('does nothing for an undecorated handler', async () => {
    await firstValueFrom(interceptor.intercept(context(makeSessionPrincipal(), undefined), handler()));
    await flush();

    expect(sink.record).not.toHaveBeenCalled();
  });

  it('reads the spec off the handler and the class', async () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride');

    await firstValueFrom(interceptor.intercept(context(makeSessionPrincipal()), handler()));

    expect(spy).toHaveBeenCalledWith(AUDIT_LOG_KEY, expect.any(Array));
  });

  it('writes a merchant audit row for a session principal', async () => {
    await firstValueFrom(interceptor.intercept(context(makeSessionPrincipal()), handler()));
    await flush();

    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'merchant.create', actorType: expect.any(String) }),
    );
    expect(sink.recordStaff).not.toHaveBeenCalled();
  });

  it('writes a staff audit row for a staff principal', async () => {
    await firstValueFrom(
      interceptor.intercept(
        context(makeStaffPrincipal({ role: 'risk', acting_merchant_id: TEST_MERCHANT_ID }), {
          action: 'merchant.status_changed',
        }),
        handler(),
      ),
    );
    await flush();

    expect(sink.recordStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merchant.status_changed',
        actingMerchantId: TEST_MERCHANT_ID,
      }),
    );
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('captures the operator’s stated reason on a staff action', async () => {
    await firstValueFrom(
      interceptor.intercept(
        context(
          makeStaffPrincipal({ role: 'risk' }),
          { action: 'merchant.status_changed' },
          { body: { status: 'suspended', reason: 'dispute rate over 100bps' } },
        ),
        handler(),
      ),
    );
    await flush();

    expect(sink.recordStaff).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'dispute rate over 100bps' }),
    );
  });

  it('records the response body as the `after` state', async () => {
    await firstValueFrom(
      interceptor.intercept(context(makeSessionPrincipal()), handler({ id: 'mch_9', status: 'active' })),
    );
    await flush();

    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({ after: { id: 'mch_9', status: 'active' } }),
    );
  });

  it('never persists a credential the response carries', async () => {
    // Regression: `after` was the raw handler result, so api_key.create stored the plaintext
    // `sk_live_…` and webhook_endpoint.create the signing secret.
    await firstValueFrom(
      interceptor.intercept(
        context(makeSessionPrincipal(), { action: 'api_key.create' }),
        handler({ id: 'key_1', secret: 'sk_live_abcd1234_s3cr3t', last_four: 'cr3t' }),
      ),
    );
    await flush();

    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({ after: { id: 'key_1', secret: '[REDACTED]', last_four: 'cr3t' } }),
    );
  });

  it('derives the resource type from the action when none is declared', async () => {
    await firstValueFrom(
      interceptor.intercept(context(makeSessionPrincipal(), { action: 'settlement.item.retry' }), handler()),
    );
    await flush();

    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'settlement' }));
  });

  it('honours an explicit resourceType', async () => {
    await firstValueFrom(
      interceptor.intercept(
        context(makeSessionPrincipal(), { action: 'merchant.create', resourceType: 'merchant' }),
        handler(),
      ),
    );
    await flush();

    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'merchant' }));
  });

  it('records the caller ip', async () => {
    await firstValueFrom(interceptor.intercept(context(makeApiKeyPrincipal()), handler()));
    await flush();

    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.7' }));
  });

  it('stamps the request id from the ambient context', async () => {
    const requestId = new RequestIdMiddleware();

    await new Promise<void>((resolve) => {
      requestId.use(
        { method: 'POST', url: '/v1/merchants', headers: {} },
        { setHeader: () => undefined },
        () => {
          attachPrincipal(makeSessionPrincipal());
          void firstValueFrom(
            interceptor.intercept(context(makeSessionPrincipal()), handler()),
          ).then(() => resolve());
        },
      );
    });
    await flush();

    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.stringMatching(/^req_/) }),
    );
  });

  it('does not audit a failed handler', async () => {
    const failing: CallHandler = { handle: () => throwError(() => new Error('422')) };

    await expect(
      firstValueFrom(interceptor.intercept(context(makeSessionPrincipal()), failing)),
    ).rejects.toThrow();
    await flush();

    // A 422 belongs in the access log, not the audit trail.
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('does not audit an unauthenticated request', async () => {
    await firstValueFrom(interceptor.intercept(context(undefined), handler()));
    await flush();

    expect(sink.record).not.toHaveBeenCalled();
  });

  it('logs loudly when the sink is unbound rather than dropping silently', async () => {
    const unbound = new AuditLogInterceptor(reflector, logger, undefined);

    await firstValueFrom(unbound.intercept(context(makeSessionPrincipal()), handler()));
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      'AUDIT_SINK is unbound — audit trail dropped',
      undefined,
      expect.objectContaining({ action: 'merchant.create' }),
    );
  });

  it('never lets an audit failure fail the request', async () => {
    sink.record.mockRejectedValue(new Error('audit table is full'));

    await expect(
      firstValueFrom(interceptor.intercept(context(makeSessionPrincipal()), handler())),
    ).resolves.toEqual({ id: 'mch_1' });
    await flush();
  });
});
