import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { firstValueFrom, of } from 'rxjs';

import type { ApiConfig } from 'src/config/api-config.type';
import { RATE_LIMIT_KEY } from 'src/common/decorators/rate-limit.decorator';
import { RateLimitedException } from 'src/common/errors/business.exceptions';
import { RateLimitInterceptor } from 'src/common/interceptors/rate-limit.interceptor';

import {
  makeApiKeyPrincipal,
  makeInternalPrincipal,
  makeSessionPrincipal,
  makeStaffPrincipal,
} from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID, TEST_OTHER_MERCHANT_ID } from 'test/factories/ids';

/**
 * The post-auth, per-merchant bucket.
 *
 * `RateLimitGuard` runs before auth and keys on IP plus a hash of the presented
 * credential, which stops a scraper and does nothing for a merchant behind a shared NAT
 * egress — and most of ours are. This interceptor keys on `principal.merchant_id`, which
 * is the bucket a real merchant actually gets throttled on.
 */
describe('RateLimitInterceptor', () => {
  let reflector: Reflector;
  let counts: Map<string, number>;
  let redis: Redis;
  let interceptor: RateLimitInterceptor;
  let headers: Record<string, string>;

  const config = { limits: { rateLimitDefaultRpm: 600 } } as unknown as ApiConfig;

  function context(
    principal: unknown,
    spec?: { limit: number; windowSec: number },
    path = '/v1/payment_intents',
  ): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(spec);
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ principal, path, route: { path } }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            headers[name.toLowerCase()] = value;
          },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  const handler: CallHandler = { handle: () => of({ ok: true }) };

  beforeEach(() => {
    reflector = new Reflector();
    counts = new Map();
    headers = {};
    redis = {
      multi: () => {
        let key = '';
        const chain = {
          incr: (k: string) => {
            key = k;
            counts.set(k, (counts.get(k) ?? 0) + 1);
            return chain;
          },
          expire: () => chain,
          exec: async () => [[null, counts.get(key) ?? 1]],
        };
        return chain;
      },
    } as unknown as Redis;
    interceptor = new RateLimitInterceptor(reflector, redis, config);
  });

  it('reads the limit off the @RateLimit decorator', async () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride');

    await interceptor.intercept(context(makeApiKeyPrincipal(), { limit: 5, windowSec: 60 }), handler);

    expect(spy).toHaveBeenCalledWith(RATE_LIMIT_KEY, expect.any(Array));
  });

  it('falls back to the configured default when the handler declares none', async () => {
    await interceptor.intercept(context(makeApiKeyPrincipal()), handler);

    expect(headers['x-ratelimit-limit']).toBe('600');
  });

  it('lets a request through under the limit', async () => {
    const observable = await interceptor.intercept(
      context(makeApiKeyPrincipal(), { limit: 5, windowSec: 60 }),
      handler,
    );

    await expect(firstValueFrom(observable)).resolves.toEqual({ ok: true });
  });

  it('reports the remaining budget', async () => {
    await interceptor.intercept(context(makeApiKeyPrincipal(), { limit: 5, windowSec: 60 }), handler);

    expect(headers['x-ratelimit-remaining']).toBe('4');
  });

  it('decrements the remaining budget across calls', async () => {
    for (let i = 0; i < 3; i += 1) {
      await interceptor.intercept(context(makeApiKeyPrincipal(), { limit: 5, windowSec: 60 }), handler);
    }

    expect(headers['x-ratelimit-remaining']).toBe('2');
  });

  it('throws RateLimitedException past the limit', async () => {
    const ctx = () => context(makeApiKeyPrincipal(), { limit: 2, windowSec: 60 });

    await interceptor.intercept(ctx(), handler);
    await interceptor.intercept(ctx(), handler);

    await expect(interceptor.intercept(ctx(), handler)).rejects.toBeInstanceOf(RateLimitedException);
  });

  it('sets Retry-After when it throttles', async () => {
    const ctx = () => context(makeApiKeyPrincipal(), { limit: 1, windowSec: 60 });

    await interceptor.intercept(ctx(), handler);
    await interceptor.intercept(ctx(), handler).catch(() => undefined);

    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never reports a negative remaining', async () => {
    const ctx = () => context(makeApiKeyPrincipal(), { limit: 1, windowSec: 60 });

    await interceptor.intercept(ctx(), handler);
    await interceptor.intercept(ctx(), handler).catch(() => undefined);

    expect(Number(headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
  });

  it('reports a reset time in whole seconds', async () => {
    await interceptor.intercept(context(makeApiKeyPrincipal(), { limit: 5, windowSec: 60 }), handler);

    const reset = Number(headers['x-ratelimit-reset']);
    expect(Number.isInteger(reset)).toBe(true);
    expect(reset * 1_000).toBeGreaterThan(Date.now());
  });

  it('keys per merchant', async () => {
    const spec = { limit: 1, windowSec: 60 };

    await interceptor.intercept(context(makeApiKeyPrincipal(), spec), handler);
    const other = makeApiKeyPrincipal({ merchant_id: TEST_OTHER_MERCHANT_ID });

    await expect(interceptor.intercept(context(other, spec), handler)).resolves.toBeDefined();
  });

  it('keys per route, so a payment intent burst does not throttle refunds', async () => {
    const spec = { limit: 1, windowSec: 60 };

    await interceptor.intercept(context(makeApiKeyPrincipal(), spec, '/v1/payment_intents'), handler);

    await expect(
      interceptor.intercept(context(makeApiKeyPrincipal(), spec, '/v1/refunds'), handler),
    ).resolves.toBeDefined();
  });

  it('applies to a dashboard session too', async () => {
    await interceptor.intercept(context(makeSessionPrincipal(), { limit: 5, windowSec: 60 }), handler);

    expect(headers['x-ratelimit-limit']).toBe('5');
  });

  it('skips a principal with no merchant', async () => {
    headers = {};

    await interceptor.intercept(context(makeInternalPrincipal(), { limit: 1, windowSec: 60 }), handler);

    // The internal surface is mTLS-gated and called by our own services; throttling it
    // would throttle the ledger's remediation path during an incident.
    expect(headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('skips an unauthenticated request — RateLimitGuard already handled it', async () => {
    headers = {};

    await interceptor.intercept(context(undefined, { limit: 1, windowSec: 60 }), handler);

    expect(headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('uses the acting merchant for a staff principal', async () => {
    await interceptor.intercept(
      context(makeStaffPrincipal({ acting_merchant_id: TEST_MERCHANT_ID }), { limit: 5, windowSec: 60 }),
      handler,
    );

    expect(headers['x-ratelimit-limit']).toBe('5');
  });
});
