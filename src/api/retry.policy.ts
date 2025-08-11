/**
 * Retry policy for outbound calls.
 *
 * api-surface.md §11 is explicit about the predicate: `502 | 503 | 504 | connect-timeout |
 * read-timeout | ECONNRESET`, and only on idempotent verbs. A timeout carries no status code
 * and is exactly the case that most needs a retry; a predicate written as "502/503/504" never
 * fires on the case it exists for.
 */

import { TransportError, type HttpMethod } from './transport.interface';

export interface RetryDecisionContext {
  method: HttpMethod;
  /** Present when the upstream answered. Absent on transport failure. */
  status?: number;
  /** Present when the socket failed. */
  error?: TransportError;
  /** 1-based. The first call is attempt 1. */
  attempt: number;
  /** Set when the caller supplied an `Idempotency-Key`; makes a non-idempotent verb replayable. */
  hasIdempotencyKey: boolean;
}

export interface RetryPolicy {
  readonly name: string;
  shouldRetry(ctx: RetryDecisionContext): boolean {
    if (ctx.attempt >= this.maxAttempts) {
      return false;
    }
    if (!this.isReplayable(ctx)) {
      return false;
    }
    if (ctx.error) {
      return (
        ctx.error.kind === 'connect_timeout' ||
        ctx.error.kind === 'read_timeout' ||
        ctx.error.kind === 'connection_reset' ||
        ctx.error.kind === 'dns_failure'
      );
    }
    return ctx.status !== undefined && RETRYABLE_STATUSES.has(ctx.status);
  }

  shouldRetry(): boolean {
    return false;
  }

  delayMs(): number {
    return 0;
  }
}
