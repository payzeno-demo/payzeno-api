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
    let store: IdempotencyStore;

    beforeEach(() => {
      harness = build();
      store = harness.store;
    });

    it('lets the first caller proceed', async () => {
      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('reports in_progress while the first caller holds the lease', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      const second = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(second.outcome).toBe('in_progress');
      if (second.outcome === 'in_progress') {
        expect(second.retryAfterSec).toBeGreaterThan(0);
      }
    });

    it('replays the completed response for the same key and fingerprint', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1' });

      const replayed = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(isReplay(replayed)).toBe(true);
      if (isReplay(replayed)) {
        expect(replayed.status).toBe(201);
        expect(replayed.body).toEqual({ id: 'pi_1' });
      }
    });

    it('reports fingerprint_mismatch when the same key carries a different body', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1' });

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-different')).resolves.toEqual({
        outcome: 'fingerprint_mismatch',
      });
    });

    it('reports fingerprint_mismatch even while the original is still in flight', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-different')).resolves.toEqual({
        outcome: 'fingerprint_mismatch',
      });
    });

    it('lets a failed attempt be retried with the same key', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      await store.fail(TEST_MERCHANT_ID, 'k1');

      // A 500 is not a business outcome; the merchant is entitled to retry.
      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('scopes keys per merchant', async () => {
      await store.begin(TEST_MERCHANT_ID, 'shared-key', 'fp1');

      await expect(store.begin(TEST_OTHER_MERCHANT_ID, 'shared-key', 'fp2')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('reclaims a lapsed lease rather than deadlocking on a crashed caller', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.expireLease(TEST_MERCHANT_ID, 'k1');

      await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });

    it('replays a null body without confusing it for "no record"', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k204', 'fp204');
      await store.complete(TEST_MERCHANT_ID, 'k204', 204, null);

      const replayed = await store.begin(TEST_MERCHANT_ID, 'k204', 'fp204');

      expect(isReplay(replayed)).toBe(true);
      if (isReplay(replayed)) {
        expect(replayed.status).toBe(204);
      }
    });

    it('keeps live and test keyspaces apart', async () => {
      const testModeStore = harness.forMode(false);

      await store.begin(TEST_MERCHANT_ID, 'same-key', 'fp1');

      await expect(testModeStore.begin(TEST_MERCHANT_ID, 'same-key', 'fp1')).resolves.toEqual({
        outcome: 'proceed',
      });
    });
  });
});
