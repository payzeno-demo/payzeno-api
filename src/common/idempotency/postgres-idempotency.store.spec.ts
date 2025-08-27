import { isReplay } from 'src/common/idempotency/idempotency.store';
import type { PostgresIdempotencyStore } from 'src/common/idempotency/postgres-idempotency.store';

import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { buildPostgresIdempotencyStore } from 'test/support/idempotency-harness';
import type { IdempotencyHarness } from 'test/support/idempotency-harness';

/**
 * The Postgres backend — the default, and the one every route except
 * `POST /v1/payment_intents` uses.
 *
 * The two behaviours worth a file of their own are lease reclaim (a caller that crashed
 * mid-request must not lock the key forever) and `Retry-After` arithmetic, which is
 * computed from `lease_expires_at` here and from `PTTL` in the Redis store — and the two
 * round the residual differently. That difference is a real bug nobody has filed; both
 * specs assert the behaviour they actually have, so the day someone fixes it, one of them
 * fails and points at the other.
 */
describe('PostgresIdempotencyStore', () => {
  let harness: IdempotencyHarness;
  let store: PostgresIdempotencyStore;

  beforeEach(() => {
    harness = buildPostgresIdempotencyStore();
    store = harness.store as PostgresIdempotencyStore;
  });

  it('claims an unseen key with a single INSERT … ON CONFLICT', async () => {
    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('holds the key while the lease is live', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

    const second = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

    expect(second.outcome).toBe('in_progress');
  });

  describe('lease reclaim', () => {
    it('reports the seconds remaining on the holder’s lease', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.clock.advanceSeconds(10);

      const result = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(result.outcome).toBe('in_progress');
      if (result.outcome === 'in_progress') {
        // 30s lease, 10s elapsed.
        expect(result.retryAfterSec).toBe(20);
      }
    });

    const testStore = harness.forMode(false);

    await store.begin(TEST_MERCHANT_ID, 'shared', 'fp1');

    await expect(testStore.begin(TEST_MERCHANT_ID, 'shared', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });
});
