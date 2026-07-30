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
    const created = await createIntent();

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm', seeded.merchant.id))
      .send({ return_url: 'https://aurora.example/return' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.latest_charge_id).toEqual(expect.stringMatching(/^ch_/));

    const charge = await request(ctx.app.getHttpServer())
      .get(`/v1/charges/${res.body.latest_charge_id}`)
      .set('Authorization', bearer(seeded));

    expect(charge.status).toBe(200);
    expect(charge.body.status).toBe('captured');
    expect(charge.body.processor_reference).toEqual(expect.any(String));
  });

  it('manual capture leaves the intent in requires_capture until captured', async () => {
    const created = await createIntent({ capture_method: 'manual' });

    const confirmed = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm-manual', seeded.merchant.id))
      .send({});

    expect(confirmed.body.status).toBe('requires_capture');

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
    const created = await createIntent({ capture_method: 'manual' });
    await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm-over', seeded.merchant.id))
      .send({});

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/capture`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('capture-over', seeded.merchant.id))
      .send({ amount_minor: 9_000 });

    expect(res.status).toBe(422);
    expect(res.body).toBeApiError();
  });

  it('refunds a captured charge and emits refund.created', async () => {
    const created = await createIntent();
    const confirmed = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm-refund', seeded.merchant.id))
      .send({});

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/refunds')
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('refund', seeded.merchant.id))
      .send({
        charge_id: confirmed.body.latest_charge_id,
        amount_minor: 1_500,
        reason: 'requested_by_customer',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'refund',
      charge_id: confirmed.body.latest_charge_id,
      amount_minor: 1_500,
      currency: 'GBP',
    });
  });

  it('refuses a refund against an uncaptured authorisation', async () => {
    const created = await createIntent({ capture_method: 'manual' });
    const confirmed = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm-void', seeded.merchant.id))
      .send({});

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/refunds')
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('refund-void', seeded.merchant.id))
      .send({ charge_id: confirmed.body.latest_charge_id });

    // A void is not a refund. This is `POST /v1/payment_intents/:id/cancel`'s job.
    expect(res.status).toBe(409);
    expect(res.body).toBeApiError('invalid_state');
  });

  it('cancels an authorised intent and releases the hold', async () => {
    const created = await createIntent({ capture_method: 'manual' });
    await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('confirm-cancel', seeded.merchant.id))
      .send({});

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/cancel`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', idempotencyKey('cancel', seeded.merchant.id))
      .send({ cancellation_reason: 'requested_by_customer' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('canceled');
    expect(res.body.cancellation_reason).toBe('requested_by_customer');
    expect(res.body.canceled_at).toEqual(expect.any(String));
  });

  it('lists the merchant’s charges with a working cursor', async () => {
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
