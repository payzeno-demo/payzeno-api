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

  it('allows a missing key when the decorator marks it optional', async () => {
    const req = { ...baseRequest, headers: {} };

    const observable = await interceptor.intercept(
      context(req, { required: false }),
      handler(),
    );

    await expect(firstValueFrom(observable)).resolves.toEqual({ id: 'pi_1' });
    expect(postgres.begin).not.toHaveBeenCalled();
  });

  it('skips scoping for a principal with no merchant — the internal surface', async () => {
    const req = { ...baseRequest, principal: makeInternalPrincipal() };

    await interceptor.intercept(context(req), handler());

    expect(postgres.begin).not.toHaveBeenCalled();
  });

  it('scopes the key to the principal’s merchant', async () => {
    await interceptor.intercept(context(baseRequest), handler());

    expect(postgres.begin).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'k-0001', expect.any(String));
  });

  it('produces a different fingerprint for a different body', async () => {
    await interceptor.intercept(context(baseRequest), handler());
    const firstPrint = postgres.begin.mock.calls[0][2];

    postgres.begin.mockClear();
    await interceptor.intercept(
      context({ ...baseRequest, body: { amount_minor: 9_900, currency: 'GBP' } }),
      handler(),
    );

    expect(postgres.begin.mock.calls[0][2]).not.toBe(firstPrint);
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

  describe('completion', () => {
    it('records the response on success', async () => {
      response.statusCode = 201;
      const observable = await interceptor.intercept(context(baseRequest), handler({ id: 'pi_1' }));
      await firstValueFrom(observable);

      expect(postgres.complete).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'k-0001',
        201,
        { id: 'pi_1' },
      );
    });

    it('marks the key failed when the handler throws', async () => {
      const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };

      const observable = await interceptor.intercept(context(baseRequest), failing);
      await expect(firstValueFrom(observable)).rejects.toThrow('boom');

      expect(postgres.fail).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'k-0001');
      expect(postgres.complete).not.toHaveBeenCalled();
    });
  });

  describe('backend selection', () => {
    it('uses the Postgres store by default', async () => {
      await interceptor.intercept(context(baseRequest), handler());

      expect(postgres.begin).toHaveBeenCalled();
      expect(redis.begin).not.toHaveBeenCalled();
    });

    it('uses the Redis store when the decorator asks for it', async () => {
      await interceptor.intercept(
        context(baseRequest, { required: true, backend: 'redis' }),
        handler(),
      );

      expect(redis.begin).toHaveBeenCalled();
      expect(postgres.begin).not.toHaveBeenCalled();
    });
  });
});
