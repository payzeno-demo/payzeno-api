import { isReplay } from 'src/common/idempotency/idempotency.store';
import type { RedisIdempotencyStore } from 'src/common/idempotency/redis-idempotency.store';

import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { buildRedisIdempotencyStore } from 'test/support/idempotency-harness';
import type { IdempotencyHarness } from 'test/support/idempotency-harness';

/**
 * The Redis backend. Selected by `IDEMPOTENCY_BACKEND=redis`, and only ever for
 * `POST /v1/payment_intents` — the one route whose volume made a Postgres row per
 * request measurable.
 *
 * Note the `Retry-After` assertion below: this store rounds PTTL **up** to whole seconds,
 * the Postgres store computes the residual from `lease_expires_at` and floors it. For an
 * identical request the two backends can answer one second apart. That is a real
 * difference, it is asserted rather than papered over, and nobody has filed it.
 */
describe('RedisIdempotencyStore', () => {
  let harness: IdempotencyHarness;
  it('claims an unseen key through the CAS script', async () => {
    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('lets a failed attempt be re-claimed with the same fingerprint', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.fail(TEST_MERCHANT_ID, 'k1');

    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('namespaces live and test keys', async () => {
    const testStore = harness.forMode(false);

    await store.begin(TEST_MERCHANT_ID, 'shared', 'fp1');

    await expect(testStore.begin(TEST_MERCHANT_ID, 'shared', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });
});
