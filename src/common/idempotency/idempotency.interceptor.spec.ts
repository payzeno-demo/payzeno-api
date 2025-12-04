import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';

import type { ApiConfig } from 'src/config/api-config.type';
import { IDEMPOTENT_KEY } from 'src/common/decorators/idempotent.decorator';
import { InvalidRequestException } from 'src/common/errors/api.exception';
import {
  IdempotencyInProgressException,
  IdempotencyKeyReuseException,
} from 'src/common/errors/idempotency.exceptions';
import {
  IdempotencyInterceptor,
  POSTGRES_IDEMPOTENCY_STORE,
  REDIS_IDEMPOTENCY_STORE,
} from 'src/common/idempotency/idempotency.interceptor';
import type { IdempotencyStore } from 'src/common/idempotency/idempotency.store';
import { NoopLogger } from 'src/common/logging/logger';

import { makeApiKeyPrincipal, makeInternalPrincipal } from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The interceptor's placement in the chain is what this file protects: it runs *after*
 * the auth guards (it needs `principal.merchant_id` to scope the key) and *before*
 * `ValidationPipe`, so a replay never re-runs validation on a body that once succeeded.
 */
describe('IdempotencyInterceptor', () => {
  let reflector: Reflector;
  let redis: jest.Mocked<IdempotencyStore>;
  let interceptor: IdempotencyInterceptor;
  let response: { statusCode: number; headers: Record<string, string>; status: jest.Mock; setHeader: jest.Mock };

  function context(
    request: Record<string, unknown>,
    decorated: unknown = { required: true },
  ): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(decorated);
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  }

  it('passes through entirely when the handler is not decorated', async () => {
    const observable = await interceptor.intercept(context(baseRequest, undefined), handler());

    await expect(firstValueFrom(observable)).resolves.toEqual({ id: 'pi_1' });
    expect(postgres.begin).not.toHaveBeenCalled();
  });

  it('reads the decorator metadata off both the handler and the class', async () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride');

    await interceptor.intercept(context(baseRequest), handler());

    expect(spy).toHaveBeenCalledWith(IDEMPOTENT_KEY, expect.any(Array));
  });

  it('skips scoping for a principal with no merchant — the internal surface', async () => {
    const req = { ...baseRequest, principal: makeInternalPrincipal() };

    await interceptor.intercept(context(req), handler());

    expect(postgres.begin).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReuseException on a fingerprint mismatch', async () => {
    postgres.begin.mockResolvedValue({ outcome: 'fingerprint_mismatch' });

    await expect(interceptor.intercept(context(baseRequest), handler())).rejects.toBeInstanceOf(
      IdempotencyKeyReuseException,
    );
  });

  it('throws IdempotencyInProgressException and sets Retry-After', async () => {
    postgres.begin.mockResolvedValue({ outcome: 'in_progress', retryAfterSec: 12 });

    await expect(interceptor.intercept(context(baseRequest), handler())).rejects.toBeInstanceOf(
      IdempotencyInProgressException,
    );
    expect(response.headers['retry-after']).toBe('12');
  });

});
