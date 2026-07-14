import request from 'supertest';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, seedTwoMerchants } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

/**
 * Tenant isolation (api-surface §1.2).
 *
 * The rule that is easy to get wrong: a cross-tenant read is **404, never 403**. A 403
 * confirms the resource exists, which is an enumeration oracle across the whole
 * platform. `MerchantScopeGuard` is the only place that decision is made, and this file
 * is the only place it is asserted from outside the process.
 */
describe('merchant scope e2e', () => {
  let ctx: TestApp;
  let own: SeededMerchant;
  let other: SeededMerchant;
  let otherIntentId: string;
  let otherChargeId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const pair = await seedTwoMerchants(ctx);
    own = pair.own;
    other = pair.other;

    const created = await request(ctx.app.getHttpServer())
      .post('/v1/payment_intents')
      .set('Authorization', bearer(other))
      .set('Idempotency-Key', 'scope-seed-intent')
      .send({
        amount_minor: 7_700,
        currency: 'GBP',
        capture_method: 'automatic',
        payment_method_token: 'pmt_visa_4242',
      });
    otherIntentId = created.body.id;

    const confirmed = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${otherIntentId}/confirm`)
      .set('Authorization', bearer(other))
      .set('Idempotency-Key', 'scope-seed-confirm')
      .send({});
    otherChargeId = confirmed.body.latest_charge_id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('404s — not 403 — reading another merchant’s payment intent', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/payment_intents/${otherIntentId}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(404);
    expect(res.body).toBeApiError('not_found');
  });

  it('404s reading another merchant’s charge', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/charges/${otherChargeId}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(404);
  });

  it('returns the same 404 body for a resource that does not exist at all', async () => {
    const foreign = await request(ctx.app.getHttpServer())
      .get(`/v1/charges/${otherChargeId}`)
      .set('Authorization', bearer(own));
    const missing = await request(ctx.app.getHttpServer())
      .get('/v1/charges/ch_definitely_not_real')
      .set('Authorization', bearer(own));

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });

  it('never leaks another merchant’s rows into a list', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/payment_intents?limit=100')
      .set('Authorization', bearer(own));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((pi: { id: string }) => pi.id);
    expect(ids).not.toContain(otherIntentId);
    for (const pi of res.body.data) {
      expect(pi.merchant_id).toBe(own.merchant.id);
    }
  });

  it('404s refunding another merchant’s charge', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/refunds')
      .set('Authorization', bearer(own))
      .set('Idempotency-Key', 'scope-refund-foreign')
      .send({ charge_id: otherChargeId, amount_minor: 100 });

    expect(res.status).toBe(404);
  });

  it('404s a merchant reading another merchant by id', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/merchants/${other.merchant.id}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(404);
  });

  it('serves the merchant its own record', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/merchants/${own.merchant.id}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(own.merchant.id);
  });

  it('401s with no credential at all', async () => {
    const res = await request(ctx.app.getHttpServer()).get(
      `/v1/payment_intents/${otherIntentId}`,
    );

    expect(res.status).toBe(401);
    expect(res.body).toBeApiError('authentication_required');
  });

  it('401s an api key that does not resolve', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/payment_intents?limit=1')
      .set('Authorization', 'Bearer sk_live_deadbeef_notarealsecretvalue');

    expect(res.status).toBe(401);
    expect(res.body).toBeApiError('invalid_api_key');
  });
});
