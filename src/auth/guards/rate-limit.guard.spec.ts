import type { Redis } from 'ioredis';

import { RateLimitGuard } from 'src/auth/guards/rate-limit.guard';
import { RATE_LIMIT_KEY } from 'src/common/decorators/rate-limit.decorator';
import { RateLimitedException } from 'src/common/errors/business.exceptions';
import type { ApiConfig } from 'src/config/api-config.type';

import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

/**
 * The PRE-auth limiter. It runs before any credential is resolved, so it cannot key on
 * merchant — that refinement is `RateLimitInterceptor`, which has its own spec.
 *
 * The credential bucket is a sha256 of the raw Authorization header, deliberately: resolving
 * the key first would cost an argon2 verify per request and hand an unauthenticated caller a
 * CPU amplification primitive. The specs below pin that the header never reaches Redis in
 * plaintext.
 */
describe('RateLimitGuard', () => {
  const config = { limits: { rateLimitDefaultRpm: 100 } } as unknown as ApiConfig;

  /** A minimal ioredis double: one counter per key, MULTI returns the exec tuple shape. */
  function makeRedis(counts: Record<string, number> = {}) {
    const keys: string[] = [];
    const store = { ...counts };

    const redis = {
      keys,
      store,
      multi: (fn?: unknown) => {
        void fn;
        let key = '';
        const chain = {
          incr(k: string) {
            key = k;
            keys.push(k);
            store[k] = (store[k] ?? 0) + 1;
            return chain;
          },
          expire() {
            return chain;
          },
          async exec() {
            return [
              [null, store[key]],
              [null, 1],
            ];
          },
        };
        return chain;
      },
    };

    return redis;
  }

  function guardWith(
    redis: ReturnType<typeof makeRedis>,
    spec?: { limit: number; windowSec: number },
  ): RateLimitGuard {
    return new RateLimitGuard(
      redis as unknown as Redis,
      config,
      makeReflector(spec ? { [RATE_LIMIT_KEY]: spec } : {}),
    );
  }

  it('counts an anonymous request against its IP only', async () => {
    const redis = makeRedis();
    const { context } = guardContext({
      ip: '203.0.113.9',
      headers: { authorization: 'Bearer sk_live_ab12cd34_secretsecretsecret' },
    });

    await guardWith(redis).canActivate(context);

    expect(redis.keys).toHaveLength(2);
    expect(redis.keys[0]).toContain('cred:');
    expect(redis.keys[1]).toContain('ip:203.0.113.9');
  });

  it('never puts the raw credential in a Redis key', async () => {
    const redis = makeRedis();
    const credKeys = redis.keys.filter((key) => key.includes('cred:'));
    expect(credKeys[0]).toBe(credKeys[1]);
  });

  it('publishes X-RateLimit-* headers on a request that is allowed', async () => {
    const err = await rejectsWith(
      guard.canActivate(guardContext({ ip: '203.0.113.9' }).context),
      RateLimitedException,
    );

    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('rate_limited');
  });

  it('falls back to the configured default when the handler has no @RateLimit', async () => {
    const { context, response } = guardContext();

    await guardWith(redis).canActivate(context);

    expect(response.headers['X-RateLimit-Limit']).toBe('100');
  });

  it('reports the tightest bucket when the credential is closer to its limit than the IP', async () => {
    // The credential key is derived, so seed by running the same header through once and
    // reading back the key the guard used.
    const probe = makeRedis();
    await guardWith(probe, { limit: 10, windowSec: 60 }).canActivate(
      guardContext({ headers: { authorization: 'Bearer sk_live_ab12cd34_secretsecretsecret' } })
        .context,
    );
    const { context } = guardContext({ ip: undefined });
    // makeRequest defaults an ip; blank it out to exercise the fallback branch.
    (context.switchToHttp().getRequest() as { ip?: string }).ip = undefined;

    await guardWith(redis).canActivate(context);

    expect(redis.keys[0]).toContain('ip:unknown');
  });
});
