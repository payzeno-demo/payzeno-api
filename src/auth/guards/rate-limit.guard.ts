/**
 * RateLimitGuard — the PRE-auth limiter.
 *
 * It runs before any credential is resolved, so it cannot key on merchant. It keys on two
 * dimensions and applies whichever is tighter (api-surface.md §1.5):
 *
 *   IP          coarse, pre-auth, `RATE_LIMIT_DEFAULT_RPM`
 *   credential  `sha256(bearer)[:16]` when an Authorization header is present — stable per
 *               API key without resolving the key, which would cost an argon2 verify per
 *               request and hand an unauthenticated caller a CPU amplification primitive.
 *
 * The per-merchant refinement is `RateLimitInterceptor`, post-auth. That is the bucket a
 * merchant behind a shared NAT egress actually gets throttled on.
 *
 * The counter is a Redis INCR with an EXPIRE on first write — a fixed window, not a sliding
 * one. A fixed window admits a 2× burst across a boundary and everybody knows it; a sliding
 * log costs a sorted set per caller and this guard runs on literally every request.
 */
import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Redis } from 'ioredis';

import { RATE_LIMIT_KEY, type RateLimitSpec } from '../../common/decorators/rate-limit.decorator';
import { RateLimitedException } from '../../common/errors/business.exceptions';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { redisKey, REDIS_CLIENT } from '../../config/redis.config';

import { headerValue, type AuthenticatedRequest } from './base-auth.guard';

interface RateLimitedResponse {
  setHeader(name: string, value: string): void;
}

interface BucketResult {
  count: number;
  limit: number;
  resetInSec: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly defaultLimit: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly reflector: Reflector,
  ) {
    this.defaultLimit = config.limits.rateLimitDefaultRpm;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const spec = declared ?? { limit: this.defaultLimit, windowSec: 60 };
    // A route's own `@RateLimit` is a budget for THAT route. Sharing the IP's general bucket
    // meant five console page loads in a minute used up the login allowance of five, and the
    // sixth request — the login — was a 429. The default budget stays shared across routes.
    const scope = declared ? `route:${context.getClass().name}.${context.getHandler().name}` : 'all';

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<RateLimitedResponse>();

    const buckets = await Promise.all(
      this.bucketKeysFor(request).map((key) => this.hit(`${key}:${scope}`, spec)),
    );

    // Whichever bucket is tightest decides, and its numbers are the ones reported.
    const tightest = buckets.reduce((worst, b) =>
      b.limit - b.count < worst.limit - worst.count ? b : worst,
    );

    this.applyHeaders(response, tightest);

    if (tightest.count > tightest.limit) {
      throw new RateLimitedException(tightest.resetInSec, tightest.limit);
    }

    return true;
  }

  /**
   * The credential bucket comes first so that, when both exist, `reduce` reports the
   * credential-keyed numbers on a tie — that is what api-surface.md §1.3 promises the
   * `X-RateLimit-*` headers mean.
   */
  private bucketKeysFor(request: AuthenticatedRequest): string[] {
    const keys: string[] = [];
    const authorization = headerValue(request.headers.authorization);

    if (authorization) {
      keys.push(`cred:${createHash('sha256').update(authorization).digest('hex').slice(0, 16)}`);
    }

    keys.push(`ip:${request.ip ?? 'unknown'}`);
    return keys;
  }

  private async hit(bucket: string, spec: RateLimitSpec): Promise<BucketResult> {
    const window = Math.floor(Date.now() / 1000 / spec.windowSec);
    const key = redisKey('rateLimit', bucket, String(window));

    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, spec.windowSec)
      .exec()) as Array<[Error | null, number]>;

    const elapsed = Math.floor(Date.now() / 1000) % spec.windowSec;

    return { count, limit: spec.limit, resetInSec: spec.windowSec - elapsed };
  }

  private applyHeaders(response: RateLimitedResponse, bucket: BucketResult): void {
    response.setHeader('X-RateLimit-Limit', String(bucket.limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(bucket.limit - bucket.count, 0)));
    response.setHeader('X-RateLimit-Reset', String(bucket.resetInSec));
  }
}
