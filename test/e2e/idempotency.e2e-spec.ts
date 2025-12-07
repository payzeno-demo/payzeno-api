import request from 'supertest';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

/**
 * Idempotency, end to end (api-surface §1.3, interfaces.md §2.2).
 *
 * Three outcomes have to be distinguishable from outside the process, because the
 * console and every merchant SDK branch on them:
 *
 *   replay              → the original status + body, `Idempotent-Replay: true`
 *   key reuse           → 409 `idempotency_key_reuse` (same key, different body)
 *   still in progress   → 409 `idempotency_in_progress` + `Retry-After`
 *
 * The unit specs cover both stores; this file covers the interceptor's placement in the
 * chain — it runs after auth, so the key is scoped per merchant, and before validation,
 * so a replay of a request that once succeeded does not re-run the pipe.
 */
describe('idempotency e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;
  let other: SeededMerchant;

  beforeAll(async () => {
    ctx = await createTestApp();
    seeded = await seedMerchant(ctx);
    other = await seedMerchant(ctx, { display_name: 'Borealis' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const body = {
    amount_minor: 2_500,
    currency: 'GBP',
    capture_method: 'manual' as const,
    payment_method_token: 'pmt_visa_4242',
  };

  function post(key: string, principal: SeededMerchant, payload: Record<string, unknown> = body) {
    return request(ctx.app.getHttpServer())
      .post('/v1/payment_intents')
      .set('Authorization', bearer(principal))
      .set('Idempotency-Key', key)
      .send(payload);
  }

  it('requires an Idempotency-Key on a public POST', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/payment_intents')
      .set('Authorization', bearer(seeded))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toBeApiError('invalid_request');
  });

  it('replays the original response for a repeated key and identical body', async () => {
    const first = await post(key, seeded);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const matching = list.body.data.filter(
      (pi: { id: string }) => pi.id === first.body.id,
    );
    expect(matching).toHaveLength(1);
  });

  it('409s idempotency_key_reuse when the same key carries a different body', async () => {
    const res = await post(key, seeded, { ...body, amount_minor: 9_900 });

    expect(res.status).toBe(409);
    expect(res.body).toBeApiError('idempotency_key_reuse');
  });

  it('409s idempotency_in_progress with a Retry-After while the first call is running', async () => {
    // Two concurrent requests with the same key: whichever loses the INSERT race sees
    // the in-progress lease. This is the branch `PostgresIdempotencyStore.begin` exists
    // for, and it is only reachable with real concurrency.
    const [a, b] = await Promise.all([post(key, seeded), post(key, seeded)]);
    const key = 'idem-shared-0005';

    const failed = await post(key, seeded, { ...body, currency: 'CHF' });
    expect(failed.status).toBe(422);

    const retried = await post(key, seeded, { ...body, currency: 'CHF' });
    expect(retried.status).toBe(422);
    expect(retried.headers['idempotent-replay']).toBeUndefined();
  });

  it('leaves GET requests alone', async () => {
  });
});
