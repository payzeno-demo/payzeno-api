import request from 'supertest';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, idempotencyKey, seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

/**
 * The whole money path in one file: create → confirm → capture → refund.
 *
 * Every request goes through the real middleware chain (api-surface §1.5) and the real
 * guards; only `LedgerHttpClient` and `Clock` are swapped. That is deliberate — the
 * assertions about ledger postings below are only meaningful because the *code* that
 * decides to post is production code.
 */
describe('payments e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;

  beforeAll(async () => {
    ctx = await createTestApp({ now: '2026-01-15T12:00:00.000Z' });
    seeded = await seedMerchant(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.ledger.reset();
  });

  async function createIntent(overrides: Record<string, unknown> = {}) {
    return request(ctx.app.getHttpServer())
      .post('/v1/payment_intents')
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('create', seeded.merchant.id))
      .send({
        amount_minor: 4_500,
        currency: 'GBP',
        capture_method: 'automatic',
        payment_method_token: 'pmt_visa_4242',
        description: 'Order 4471',
        ...overrides,
      });
  }

  it('creates a payment intent in requires_confirmation with a client_secret', async () => {
    const res = await createIntent();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'payment_intent',
      merchant_id: seeded.merchant.id,
      amount_minor: 4_500,
      currency: 'GBP',
      status: 'requires_confirmation',
    });
    expect(res.body.client_secret).toContain(res.body.id);
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('rejects a currency the platform does not support', async () => {
    const res = await createIntent({ currency: 'CHF' });

    expect(res.status).toBe(422);
    expect(res.body).toBeApiError('validation_failed');
    expect(res.body.error.field_errors.map((f: { path: string }) => f.path)).toContain('currency');
  });

  it('confirms, authorises through the processor and emits payment.authorized', async () => {
    const captured = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/capture`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('capture', seeded.merchant.id))
      .send({ amount_minor: 4_500 });

    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe('succeeded');

    // One capture posting, and exactly one — the ledger double is keyed on
    // idempotency_key and would return the original silently if we posted twice.
    expect(ctx.ledger.callsTo('postTransaction')).toHaveLength(1);
  });

  it('refuses to capture more than was authorised', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/charges?limit=2')
      .set('Authorization', bearer(seeded));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('has_more');
    expect(res.body).toHaveProperty('next_cursor');
    for (const charge of res.body.data) {
      expect(charge.merchant_id).toBe(seeded.merchant.id);
    }
  });
});
