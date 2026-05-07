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
  let store: RedisIdempotencyStore;

  beforeEach(() => {
    harness = buildRedisIdempotencyStore();
    store = harness.store as RedisIdempotencyStore;
  });

  it('claims an unseen key through the CAS script', async () => {
    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('reports in_progress for a concurrent caller', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

    const second = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

    expect(second.outcome).toBe('in_progress');
  });

  it('replays a completed response', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1' });

    const replayed = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

    expect(isReplay(replayed)).toBe(true);
    if (isReplay(replayed)) {
      expect(replayed.status).toBe(201);
      expect(replayed.body).toEqual({ id: 'pi_1' });
    }
  });

  it('preserves the fingerprint across complete(), so a later mismatch is still caught', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.complete(TEST_MERCHANT_ID, 'k1', 201, { id: 'pi_1' });

    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-other')).resolves.toEqual({
      outcome: 'fingerprint_mismatch',
    });
  });

  it('lets a failed attempt be re-claimed with the same fingerprint', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.fail(TEST_MERCHANT_ID, 'k1');

    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('does not re-claim a failed attempt for a different fingerprint', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.fail(TEST_MERCHANT_ID, 'k1');

    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-other')).resolves.toEqual({
      outcome: 'fingerprint_mismatch',
    });
  });

  it('shortens the TTL on failure so a dead key does not sit for 24h', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    await store.fail(TEST_MERCHANT_ID, 'k1');
    harness.clock.advanceSeconds(120);

    // The 60s failure TTL has lapsed; the key is simply gone.
    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp-anything')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  it('fail() on an unknown key is a no-op, not a write', async () => {
    await expect(store.fail(TEST_MERCHANT_ID, 'never-seen')).resolves.toBeUndefined();
  });

  it('lets the lease expire naturally and re-claims the key', async () => {
    await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
    harness.clock.advanceSeconds(31);

    await expect(store.begin(TEST_MERCHANT_ID, 'k1', 'fp1')).resolves.toEqual({
      outcome: 'proceed',
    });
  });

  describe('Retry-After', () => {
    it('rounds the remaining PTTL UP to whole seconds', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.clock.advanceMs(10_500);

      const result = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      expect(result.outcome).toBe('in_progress');
      if (result.outcome === 'in_progress') {
        // 19.5s left → 20. The Postgres store would answer 19 for the same instant.
        expect(result.retryAfterSec).toBe(20);
      }
    });

    it('floors at 1 rather than reporting 0', async () => {
      await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');
      harness.clock.advanceMs(29_999);

      const result = await store.begin(TEST_MERCHANT_ID, 'k1', 'fp1');

      if (result.outcome === 'in_progress') {
        expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
      }
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
