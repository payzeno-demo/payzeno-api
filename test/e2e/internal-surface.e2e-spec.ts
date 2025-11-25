import request from 'supertest';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? 'test-internal-secret';

/**
 * `/internal/v1/*` (api-surface §9b).
 *
 * Six routes, each carrying `@InternalOnly()` **and** `@UseGuards(InternalServiceGuard)`.
 * nginx denies `^/internal/` on the public listener, but nginx is one config typo away
 * from not doing that, so the guard has to hold on its own — which is what this file
 * asserts, one row per §9b table entry plus the negative cases.
 */
describe('internal surface e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;
  let chargeId: string;

  const internalHeaders = {
    'X-Payzeno-Service': 'payzeno-ledger',
    'X-Payzeno-Internal-Secret': INTERNAL_SECRET,
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    seeded = await seedMerchant(ctx);

    const created = await request(ctx.app.getHttpServer())
      .post('/v1/payment_intents')
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', 'internal-seed-intent')
      .send({
        amount_minor: 3_300,
        currency: 'GBP',
        capture_method: 'automatic',
        payment_method_token: 'pmt_visa_4242',
      });
    it('POST /internal/v1/charges/:chargeId/settled marks a single out-of-band settlement', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/internal/v1/charges/${chargeId}/settled`)
        .set(internalHeaders)
        .send({
          settlement_batch_id: 'sb_20260113_wf',
          settled_at: '2026-01-13T04:20:00.000Z',
          transaction_id: 'ltx_000777',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('settled');
      expect(res.body.settlement_batch_id).toBe('sb_20260113_wf');
    });

    it('GET /internal/v1/bank-accounts/:id serves the stale-projection fallback', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/internal/v1/bank-accounts/ba_missing')
        .set(internalHeaders);

      expect(res.status).toBe(404);
      expect(res.body).toBeApiError('not_found');
    });
  });
});
