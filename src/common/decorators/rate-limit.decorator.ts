/**
 * `@RateLimit(limit, windowSec)` — per-route override of RATE_LIMIT_DEFAULT_RPM.
 *
 * Sites: /v1/auth/login (5/60 — credential stuffing), /v1/payment_intents (300/60),
 * /v1/refunds (60/60).
 *
 * Read by RateLimitGuard pre-auth (IP + credential hash) and refined per merchant by
 * RateLimitInterceptor post-auth. api-surface.md §1.5.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'payzeno:rate_limit';

export interface RateLimitSpec {
  limit: number;
  windowSec: number;
}

export const RateLimit = (limit: number, windowSec: number): CustomDecorator =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSec } satisfies RateLimitSpec);
