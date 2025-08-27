import type { IdempotencyStore } from 'src/common/idempotency/idempotency.store';
import { isReplay } from 'src/common/idempotency/idempotency.store';

import { TEST_MERCHANT_ID, TEST_OTHER_MERCHANT_ID } from 'test/factories/ids';
import {
  buildPostgresIdempotencyStore,
  buildRedisIdempotencyStore,
} from 'test/support/idempotency-harness';
import type { IdempotencyHarness } from 'test/support/idempotency-harness';

/**
 * The `IdempotencyStore` contract, over both backends.
 *
 * `IDEMPOTENCY_BACKEND` picks between them at boot and `POST /v1/payment_intents` is the
 * only route that gets Redis, so the two implementations must agree on everything a
 * caller can observe. They very nearly do — the one place they differ is `Retry-After`
 * rounding, which is asserted separately in each backend's own spec because it is a real
 * (small, unfiled) bug and pinning it here would hide it.
 */

const backends: Array<{ name: string; build: () => IdempotencyHarness }> = [
  { name: 'PostgresIdempotencyStore', build: buildPostgresIdempotencyStore },
  { name: 'RedisIdempotencyStore', build: buildRedisIdempotencyStore },
];

describe('IdempotencyStore contract', () => {
  describe.each(backends)('$name', ({ build }) => {
    let harness: IdempotencyHarness;
    beforeEach(() => {
      harness = build();
      store = harness.store;
    });

    it('reports in_progress while the first caller holds the lease', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      const second = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(second.outcome).toBe('in_progress');
      if (second.outcome === 'in_progress') {
        expect(second.retryAfterSec).toBeGreaterThan(0);
      }
    });

  });
});
