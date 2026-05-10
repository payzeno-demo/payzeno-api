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
  readonly maxAttempts: number;
  shouldRetry(ctx: RetryDecisionContext): boolean;
  /** Backoff before the next attempt, in milliseconds. */
  delayMs(attempt: number): number;
}

const IDEMPOTENT_VERBS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'DELETE']);

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The production policy for `LedgerHttpClient`, `VaultClient` and `AcquirerHttpClient`.
 *
 * A POST is retried only when it carries an `Idempotency-Key` — which is why
 * `postTransaction` is safe to retry and `POST /v2/authorizations` without a key is not.
 */
export class IdempotentRetryPolicy implements RetryPolicy {
  readonly name = 'idempotent';

  constructor(
    readonly maxAttempts: number = 3,
    private readonly baseDelayMs: number = 100,
    private readonly jitterRatio: number = 0.2,
  ) {}

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

  private isReplayable(ctx: RetryDecisionContext): boolean {
    if (IDEMPOTENT_VERBS.has(ctx.method)) {
      return true;
    }
    // A connect timeout never reached the upstream, so even an unkeyed POST is free to replay.
    if (ctx.error?.definitelyNotDelivered) {
      return true;
    }
    return ctx.hasIdempotencyKey;
  }
}

/**
 * Used by `BillingLegacyClient`: the Java service is fronted by an opossum breaker and retrying
 * through a half-open circuit just spends the probe. Also used by the acquirer adapters for
 * `void`, which the schemes do not make idempotent.
 */
export class NoRetryPolicy implements RetryPolicy {
  shouldRetry(): boolean {
    return false;
  }

  delayMs(): number {
    return 0;
  }
}
