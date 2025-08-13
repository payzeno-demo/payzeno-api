/**
 * `@Idempotent()` — requires an `Idempotency-Key` header and routes the handler through
 * IdempotencyInterceptor.
 *
 * 17 sites: every public POST, PATCH and DELETE. api-surface.md §1.3.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'payzeno:idempotent';

export interface IdempotentOptions {
  /**
   * Force a store for this route. `POST /v1/payment_intents` pins redis because it is the
   * highest-volume mutating route; everything else takes the IDEMPOTENCY_BACKEND default.
   */
  backend?: 'postgres' | 'redis';
  /** Reject rather than mint when the header is absent. Always true on public routes. */
  required?: boolean;
}

export const Idempotent = (options: IdempotentOptions = {}): CustomDecorator =>
  SetMetadata(IDEMPOTENT_KEY, { required: true, ...options });
