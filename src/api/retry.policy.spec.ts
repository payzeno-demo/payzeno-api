import {
  IdempotentRetryPolicy,
  NoRetryPolicy,
  RETRYABLE_STATUSES,
} from 'src/api/retry.policy';
import type { RetryDecisionContext, RetryPolicy } from 'src/api/retry.policy';
import { TransportError } from 'src/api/transport.interface';

/**
 * api-surface.md §11's retry predicate, asserted literally: `502 | 503 | 504 |
 * connect-timeout | read-timeout | ECONNRESET`, idempotent verbs only.
 *
 * The timeout cases are the whole point. A timeout carries no status code, so a predicate
 * written as "retry on 502/503/504" never fires on the case that most needs a retry —
 * and that predicate is what `postTransaction` depends on to survive a ledger read
 * timeout without the caller seeing a 502.
 */
describe('IdempotentRetryPolicy', () => {
  const policy = new IdempotentRetryPolicy(3, 100, 0);

  function ctx(overrides: Partial<RetryDecisionContext> = {}): RetryDecisionContext {
    return {
      method: 'GET',
      attempt: 1,
      hasIdempotencyKey: false,
      ...overrides,
    };
  }

  function transportError(kind: TransportError['kind']): TransportError {
    return new TransportError(kind, 'http://ledger.test/x', kind);
  }

  it('names itself for the logs', () => {
    expect(policy.name).toBe('idempotent');
    expect(policy.maxAttempts).toBe(3);
  });

  describe('status-based retries', () => {
    it.each([502, 503, 504])('retries a %d on a GET', (status) => {
      expect(policy.shouldRetry(ctx({ status }))).toBe(true);
    });

    it.each([400, 401, 402, 403, 404, 409, 422, 429, 500])(
      'does not retry a %d',
      (status) => {
        expect(policy.shouldRetry(ctx({ status }))).toBe(false);
      },
    );

    it('does not retry a 2xx', () => {
      expect(policy.shouldRetry(ctx({ status: 200 }))).toBe(false);
    });

    it('exposes the retryable status set', () => {
      expect([...RETRYABLE_STATUSES].sort()).toEqual([502, 503, 504]);
    });
  });

  describe('transport failures', () => {
    it.each(['connect_timeout', 'read_timeout', 'connection_reset', 'dns_failure'] as const)(
      'retries a %s on a GET',
      (kind) => {
        expect(policy.shouldRetry(ctx({ error: transportError(kind) }))).toBe(true);
      },
    );

    it('does not retry a generic network error', () => {
      expect(policy.shouldRetry(ctx({ error: transportError('network') }))).toBe(false);
    });
  });

  describe('verb safety', () => {
    it('retries a DELETE', () => {
      expect(policy.shouldRetry(ctx({ method: 'DELETE', status: 503 }))).toBe(true);
    });

    it('does not retry an unkeyed POST that the upstream answered', () => {
      expect(policy.shouldRetry(ctx({ method: 'POST', status: 503 }))).toBe(false);
    });

    it('retries a POST that carries an idempotency key', () => {
      // Which is why `postTransaction` is safe to retry and an unkeyed
      // `POST /v2/authorizations` is not.
      expect(
        policy.shouldRetry(ctx({ method: 'POST', status: 503, hasIdempotencyKey: true })),
      ).toBe(true);
    });

    it('retries an unkeyed POST that never reached the upstream', () => {
      // A connect timeout means the request was not delivered, so the replay is free.
      expect(
        policy.shouldRetry(ctx({ method: 'POST', error: transportError('connect_timeout') })),
      ).toBe(true);
    });

    it('does not retry an unkeyed POST that timed out on READ', () => {
      // A read timeout means it probably WAS delivered. Replaying it is a second charge.
      expect(
        policy.shouldRetry(ctx({ method: 'POST', error: transportError('read_timeout') })),
      ).toBe(false);
    });

    it('does not retry an unkeyed PATCH', () => {
      expect(policy.shouldRetry(ctx({ method: 'PATCH', status: 503 }))).toBe(false);
    });
  });

  describe('attempt budget', () => {
    it('stops at maxAttempts', () => {
      expect(policy.shouldRetry(ctx({ status: 503, attempt: 2 }))).toBe(true);
      expect(policy.shouldRetry(ctx({ status: 503, attempt: 3 }))).toBe(false);
      expect(policy.shouldRetry(ctx({ status: 503, attempt: 4 }))).toBe(false);
    });

    it('honours a lower budget', () => {
      const once = new IdempotentRetryPolicy(1);

      expect(once.shouldRetry(ctx({ status: 503, attempt: 1 }))).toBe(false);
    });
  });

  describe('delayMs', () => {
    it('is exponential in the attempt number', () => {
      expect(policy.delayMs(1)).toBe(100);
      expect(policy.delayMs(2)).toBe(200);
      expect(policy.delayMs(3)).toBe(400);
    });

    it('never returns a negative delay, even with jitter', () => {
      const jittery = new IdempotentRetryPolicy(3, 100, 1);

      for (let i = 0; i < 200; i += 1) {
        expect(jittery.delayMs(1)).toBeGreaterThanOrEqual(0);
      }
    });

    it('stays within the jitter band', () => {
      const jittery = new IdempotentRetryPolicy(3, 100, 0.2);

      for (let i = 0; i < 200; i += 1) {
        const delay = jittery.delayMs(2);
        expect(delay).toBeGreaterThanOrEqual(160);
        expect(delay).toBeLessThanOrEqual(240);
      }
    });

    it('treats attempt 0 as the first attempt rather than halving the delay', () => {
      expect(policy.delayMs(0)).toBe(100);
    });
  });
});

describe('NoRetryPolicy', () => {
  const policy: RetryPolicy = new NoRetryPolicy();

  it('names itself', () => {
    expect(policy.name).toBe('none');
    expect(policy.maxAttempts).toBe(1);
  });

  it('never retries, whatever happened', () => {
    for (const status of [502, 503, 504, 500, 200]) {
      expect(
        policy.shouldRetry({ method: 'GET', status, attempt: 1, hasIdempotencyKey: true }),
      ).toBe(false);
    }
  });

  it('never retries a transport failure either', () => {
    // Retrying through a half-open circuit just spends the probe.
    expect(
      policy.shouldRetry({
        method: 'GET',
        error: new TransportError('read_timeout', 'http://billing.test/x', 'timeout'),
        attempt: 1,
        hasIdempotencyKey: true,
      }),
    ).toBe(false);
  });

  it('reports a zero delay', () => {
    expect(policy.delayMs(1)).toBe(0);
  });
});
