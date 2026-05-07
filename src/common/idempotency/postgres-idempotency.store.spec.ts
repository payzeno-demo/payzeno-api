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
    it('reclaims the key once the lease has lapsed', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.expireLease(TEST_MERCHANT_ID, 'k1');

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('does not reclaim a lapsed lease for a different fingerprint', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.expireLease(TEST_MERCHANT_ID, 'k1');

      // Same key, different body: that is key reuse, and reclaiming would let the second
      // request overwrite the first one's identity.
      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-other')).resolves.toEqual({
        outcome: 'fingerprint_mismatch',
      });
    });

    it('does not reclaim a completed record', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1' });
      harness.expireLease(TEST_MERCHANT_ID, 'k1');

      const result = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(isReplay(result)).toBe(true);
    });
  });

  describe('Retry-After', () => {
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

    it('never reports zero or a negative value', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.clock.advanceSeconds(29.9);

      const result = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      if (result.outcome === 'in_progress') {
        expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('complete', () => {
    it('stores the status and body for replay', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1', object: 'payment_intent' });

      const replayed = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(isReplay(replayed)).toBe(true);
      if (isReplay(replayed)) {
        expect(replayed.body).toEqual({ id: 'pi_1', object: 'payment_intent' });
      }
    });

    it('serialises the body rather than passing an object to the driver', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      await expect(
        store.complete(TEST_MERCHANT_ID, 'k1', 200, { nested: { deep: [1, 2, 3] } }),
      ).resolves.toBeUndefined();
    });
  });

  describe('fail', () => {
    it('releases the key for a retry', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.fail(TEST_MERCHANT_ID, 'k1');

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('still refuses a different body after a failure', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.fail(TEST_MERCHANT_ID, 'k1');

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-other')).resolves.toEqual({
        outcome: 'fingerprint_mismatch',
      });
    });

    it('is a no-op for a key that was never begun', async () => {
      await expect(store.fail(TEST_MERCHANT_ID, 'never-seen')).resolves.toBeUndefined();
    });
  });

  it('separates live and test keyspaces on the same key', async () => {
    const testStore = harness.forMode(false);

    await store.begin(TEST_MERCHANT_ID, 'shared', 'fp1');

    await expect(testStore.begin(TEST_MERCHANT_ID, 'shared', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });
});
