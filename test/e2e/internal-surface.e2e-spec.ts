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
    const confirmed = await request(ctx.app.getHttpServer())
      .post(`/v1/payment_intents/${created.body.id}/confirm`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', 'internal-seed-confirm')
      .send({});
    chargeId = confirmed.body.latest_charge_id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('rejection', () => {
    const routes: ReadonlyArray<[string, string]> = [
      ['get', '/internal/v1/merchants/mch_anything'],
      ['get', '/internal/v1/charges/ch_anything'],
      ['post', '/internal/v1/charges/ch_anything/settled'],
      ['get', '/internal/v1/webhook_endpoints?merchant_id=mch_anything'],
      ['post', '/internal/v1/support-tasks'],
      ['get', '/internal/v1/bank-accounts/ba_anything'],
    ];

    it.each(routes)('401s %s %s with no internal credentials', async (verb, path) => {
      const res = await (request(ctx.app.getHttpServer()) as never as Record<
        string,
        (p: string) => request.Test
      >)[verb](path).send({});

      expect(res.status).toBe(401);
      expect(res.body).toBeApiError();
    });

    it('401s a merchant api key on an internal route', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/merchants/${seeded.merchant.id}`)
        .set('Authorization', bearer(seeded));

      expect(res.status).toBe(401);
    });

    it('401s the right service header with the wrong shared secret', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/merchants/${seeded.merchant.id}`)
        .set('X-Payzeno-Service', 'payzeno-ledger')
        .set('X-Payzeno-Internal-Secret', 'wrong');

      expect(res.status).toBe(401);
    });

    it('401s an unknown service name even with the right secret', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/merchants/${seeded.merchant.id}`)
        .set('X-Payzeno-Service', 'payzeno-console')
        .set('X-Payzeno-Internal-Secret', INTERNAL_SECRET);

      expect(res.status).toBe(401);
    });
  });

  describe('the six routes, authenticated', () => {
    it('GET /internal/v1/merchants/:merchantId returns the full merchant config', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/merchants/${seeded.merchant.id}`)
        .set(internalHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        object: 'merchant',
        id: seeded.merchant.id,
        capture_at_settlement: false,
      });
      // The ledger's merchant_projection is fed from these fields; all of them must be here.
      expect(res.body).toHaveProperty('reserve_bps');
      expect(res.body).toHaveProperty('payout_delay_days');
      expect(res.body).toHaveProperty('settlement_tolerance_minor');
    });

    it('GET /internal/v1/charges/:chargeId serves the cold read after an orphan', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/charges/${chargeId}`)
        .set(internalHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ object: 'charge', id: chargeId });
      expect(res.body.processor_reference).toEqual(expect.any(String));
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

    it('POST /internal/v1/charges/:chargeId/settled is idempotent', async () => {
      const again = await request(ctx.app.getHttpServer())
        .post(`/internal/v1/charges/${chargeId}/settled`)
        .set(internalHeaders)
        .send({
          settlement_batch_id: 'sb_20260113_wf',
          settled_at: '2026-01-13T04:20:00.000Z',
          transaction_id: 'ltx_000777',
        });

      expect(again.status).toBe(200);
      expect(again.body.status).toBe('settled');
    });

    it('GET /internal/v1/webhook_endpoints answers the fanout question', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/internal/v1/webhook_endpoints?merchant_id=${seeded.merchant.id}&status=enabled`)
        .set(internalHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('has_more');
    });

    it('POST /internal/v1/support-tasks accepts the duplicate_detected branch', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/internal/v1/support-tasks')
        .set(internalHeaders)
        .send({
          kind: 'duplicate_settlement',
          merchant_id: seeded.merchant.id,
          charge_id: chargeId,
          severity: 'high',
          title: 'Duplicate settlement posting detected',
          body: 'retry_scheduler lost the race with the batch pass on ri_000042',
          source_event_id: 'evt_dup_000042',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toEqual(expect.stringMatching(/^st_/));
    });

    it('deduplicates support tasks on source_event_id', async () => {
      const payload = {
        kind: 'duplicate_settlement',
        merchant_id: seeded.merchant.id,
        charge_id: chargeId,
        severity: 'high',
        title: 'Duplicate settlement posting detected',
        body: 'redelivered',
        source_event_id: 'evt_dup_000099',
      };
      const first = await request(ctx.app.getHttpServer())
        .post('/internal/v1/support-tasks')
        .set(internalHeaders)
        .send(payload);
      const second = await request(ctx.app.getHttpServer())
        .post('/internal/v1/support-tasks')
        .set(internalHeaders)
        .send(payload);

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
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
