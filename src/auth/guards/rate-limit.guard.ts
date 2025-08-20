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
    const authorization = headerValue(request.headers.authorization);

    if (authorization) {
      keys.push(`cred:${createHash('sha256').update(authorization).digest('hex').slice(0, 16)}`);
    }

    keys.push(`ip:${request.ip ?? 'unknown'}`);
    return keys;
  }

  private async hit(bucket: string, spec: RateLimitSpec): Promise<BucketResult> {
    const elapsed = Math.floor(Date.now() / 1000) % spec.windowSec;

    return { count, limit: spec.limit, resetInSec: spec.windowSec - elapsed };
  }

  private applyHeaders(response: RateLimitedResponse, bucket: BucketResult): void {
    response.setHeader('X-RateLimit-Limit', String(bucket.limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(bucket.limit - bucket.count, 0)));
    response.setHeader('X-RateLimit-Reset', String(bucket.resetInSec));
  }
}
