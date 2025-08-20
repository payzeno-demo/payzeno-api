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
    const redis = makeRedis();
    const redis = makeRedis();
    const credKeys = redis.keys.filter((key) => key.includes('cred:'));
    expect(credKeys[0]).toBe(credKeys[1]);
  });

  it('publishes X-RateLimit-* headers on a request that is allowed', async () => {
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
  });
});
