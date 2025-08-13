/**
 * RateLimitInterceptor — the POST-auth, per-merchant refinement.
 *
 * RateLimitGuard runs before auth and therefore cannot key on merchant: it keys on IP and on
 * a hash of the presented credential. That is enough to stop a scraper and not enough for a
 * merchant behind a shared NAT egress, which is what most of ours are. This interceptor keys
 * on `principal.merchant_id` and is the bucket a real merchant actually gets throttled on.
 *
 * The `X-RateLimit-*` headers report whichever bucket is tighter. api-surface.md §1.5.
 */
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';

import type { AuthPrincipal } from '@payzeno/contracts';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { redisKey, REDIS_CLIENT } from '../../config/redis.config';
import { RATE_LIMIT_KEY, type RateLimitSpec } from '../decorators/rate-limit.decorator';
import { RateLimitedException } from '../errors/business.exceptions';

interface HttpRequest {
  principal?: AuthPrincipal;
  route?: { path?: string };
  path: string;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

export interface BucketState {
  count: number;
  limit: number;
  resetAtMs: number;
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const res = context.switchToHttp().getResponse<HttpResponse>();
    const merchantId = merchantIdOf(req.principal);

    if (!merchantId) return next.handle();

    const spec = this.specFor(context);
    const route = req.route?.path ?? req.path;
    const state = await this.consume(`${merchantId}:${route}`, spec);

    res.setHeader('X-RateLimit-Limit', String(state.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, state.limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAtMs / 1000)));

    if (state.count > state.limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAtMs - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      throw new RateLimitedException(retryAfter, state.limit);
    }

    return next.handle();
  }

  private specFor(context: ExecutionContext): RateLimitSpec {
    const declared = this.reflector.getAllAndOverride<RateLimitSpec | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return declared ?? { limit: this.config.limits.rateLimitDefaultRpm, windowSec: 60 };
  }

  /** Fixed window. INCR + EXPIRE-on-first is two commands and one round trip in a pipeline. */
  private async consume(bucket: string, spec: RateLimitSpec): Promise<BucketState> {
    const window = Math.floor(Date.now() / (spec.windowSec * 1000));
    const key = redisKey('rateLimit', bucket, String(window));

    const results = await this.redis.multi().incr(key).expire(key, spec.windowSec).exec();
    const count = Number(results?.[0]?.[1] ?? 1);

    return {
      count,
      limit: spec.limit,
      resetAtMs: (window + 1) * spec.windowSec * 1000,
    };
  }
}

type Observable = ReturnType<CallHandler['handle']>;

function merchantIdOf(principal: AuthPrincipal | undefined): string | null {
  if (!principal) return null;
  switch (principal.kind) {
    case 'api_key':
    case 'dashboard_session':
    case 'client_secret':
      return principal.merchant_id;
    case 'staff_session':
      // Staff are not rate limited per merchant; they act across tenants by design.
      return null;
    case 'internal_service':
      return null;
  }
}
