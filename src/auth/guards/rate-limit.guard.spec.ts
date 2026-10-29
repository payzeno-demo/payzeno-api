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
    const { context } = guardContext({ ip: '203.0.113.9' });

    await expect(guardWith(redis).canActivate(context)).resolves.toBe(true);

    expect(redis.keys).toHaveLength(1);
    expect(redis.keys[0]).toContain('ip:203.0.113.9');
  });

  it('counts a credentialed request against both the credential and the IP', async () => {
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
    const { context } = guardContext({
      headers: { authorization: 'Bearer sk_live_ab12cd34_secretsecretsecret' },
    });

    await guardWith(redis).canActivate(context);

    for (const key of redis.keys) {
      expect(key).not.toContain('secretsecretsecret');
      expect(key).not.toContain('sk_live_');
    }
  });

  it('is stable per credential — the same token hashes to the same bucket', async () => {
    const redis = makeRedis();
    const header = 'Bearer sk_live_ab12cd34_secretsecretsecret';

    await guardWith(redis).canActivate(guardContext({ headers: { authorization: header } }).context);
    await guardWith(redis).canActivate(guardContext({ headers: { authorization: header } }).context);

    const credKeys = redis.keys.filter((key) => key.includes('cred:'));
    expect(credKeys[0]).toBe(credKeys[1]);
  });

  it('gives a route its own @RateLimit budget instead of spending the IP\'s shared one', async () => {
    // Five ordinary requests from the console used to exhaust login's five-per-minute.
    const redis = makeRedis();
    for (let i = 0; i < 5; i += 1) {
      await guardWith(redis).canActivate(guardContext({ ip: '203.0.113.9' }).context);
    }

    await expect(
      guardWith(redis, { limit: 5, windowSec: 60 }).canActivate(guardContext({ ip: '203.0.113.9' }).context),
    ).resolves.toBe(true);

    const [shared, declared] = [redis.keys[0], redis.keys[5]];
    expect(shared).toContain('ip:203.0.113.9:all');
    expect(declared).toContain('ip:203.0.113.9:route:TestController.handler');
  });

  it('publishes X-RateLimit-* headers on a request that is allowed', async () => {
    const redis = makeRedis();
    const { context, response } = guardContext({ ip: '203.0.113.9' });

    await guardWith(redis, { limit: 5, windowSec: 60 }).canActivate(context);

    expect(response.headers['X-RateLimit-Limit']).toBe('5');
    expect(response.headers['X-RateLimit-Remaining']).toBe('4');
    expect(Number(response.headers['X-RateLimit-Reset'])).toBeGreaterThan(0);
  });

  it('throws 429 once the count passes the handler’s limit', async () => {
    const redis = makeRedis();
    const spec = { limit: 2, windowSec: 60 };
    const guard = guardWith(redis, spec);

    await guard.canActivate(guardContext({ ip: '203.0.113.9' }).context);
    await guard.canActivate(guardContext({ ip: '203.0.113.9' }).context);

    const err = await rejectsWith(
      guard.canActivate(guardContext({ ip: '203.0.113.9' }).context),
      RateLimitedException,
    );

    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('rate_limited');
  });

  it('falls back to the configured default when the handler has no @RateLimit', async () => {
    const redis = makeRedis();
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
    const credKey = probe.keys.find((key) => key.includes('cred:')) as string;

    const redis = makeRedis({ [credKey]: 8 });
    const { context, response } = guardContext({
      ip: '203.0.113.9',
      headers: { authorization: 'Bearer sk_live_ab12cd34_secretsecretsecret' },
    });

    await guardWith(redis, { limit: 10, windowSec: 60 }).canActivate(context);

    // 9 of 10 used on the credential, 1 of 10 on the IP — the credential's numbers win.
    expect(response.headers['X-RateLimit-Remaining']).toBe('1');
  });

  it('marks the IP bucket with the caller’s address even when it is unknown', async () => {
    const redis = makeRedis();
    const { context } = guardContext({ ip: undefined });
    // makeRequest defaults an ip; blank it out to exercise the fallback branch.
    (context.switchToHttp().getRequest() as { ip?: string }).ip = undefined;

    await guardWith(redis).canActivate(context);

    expect(redis.keys[0]).toContain('ip:unknown');
  });
});
