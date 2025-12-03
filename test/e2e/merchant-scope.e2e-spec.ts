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
  it('404s reading another merchant’s charge', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/charges/${otherChargeId}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(404);
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

  it('serves the merchant its own record', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/merchants/${own.merchant.id}`)
      .set('Authorization', bearer(own));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(own.merchant.id);
  });

  it('401s an api key that does not resolve', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/payment_intents?limit=1')
      .set('Authorization', 'Bearer sk_live_deadbeef_notarealsecretvalue');

    expect(res.status).toBe(401);
    expect(res.body).toBeApiError('invalid_api_key');
  });
});
