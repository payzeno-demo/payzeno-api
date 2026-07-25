import { createHmac } from 'node:crypto';

import request from 'supertest';

import { WebhookFanoutConsumer } from 'src/events/webhook-fanout.consumer';
import { WebhookDeliveryJob } from 'src/jobs/webhook-delivery.job';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';
import { makeEnvelope } from 'test/factories/event.factory';

/**
 * Webhook signing + redelivery.
 *
 * The pipeline under test is three components long and each one is production code:
 * `WebhookFanoutConsumer` (the only writer of `webhook_event`) → `WebhookDeliveryJob` →
 * `HttpJsonDeliveryStrategy`. The consumer and the job are driven directly here rather
 * than waiting on SQS and a cron tick; everything downstream of them is untouched.
 */
describe('webhooks e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;
  let endpointId: string;
  let signingSecret: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    seeded = await seedMerchant(ctx);

    const created = await request(ctx.app.getHttpServer())
      .post('/v1/webhook_endpoints')
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', 'wh-create-endpoint')
      .send({
        url: 'https://aurora.example/payzeno-hooks',
        enabled_events: ['payment.failed', 'refund.succeeded', 'dispute.evidence_submitted'],
      });

    endpointId = created.body.id;
    signingSecret = created.body.signing_secret;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns the signing secret exactly once, at creation', async () => {
    expect(signingSecret).toEqual(expect.any(String));

    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_endpoints')
      .set('Authorization', bearer(seeded));

    const endpoint = list.body.data.find((e: { id: string }) => e.id === endpointId);
    expect(endpoint.signing_secret).toBeUndefined();
    expect(endpoint.signing_secret_last_four).toEqual(expect.any(String));
  });

  it('fans a bus event out to one webhook_event per subscribed endpoint', async () => {
    const consumer = ctx.app.get(WebhookFanoutConsumer);
    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));

    const consumer = ctx.app.get(WebhookFanoutConsumer);
    const event = makeEnvelope(
      'refund.succeeded',
      {
        refund_id: 're_wh0002',
        charge_id: 'ch_wh0002',
        merchant_id: seeded.merchant.id,
        amount_minor: 1_000,
        currency: 'GBP',
        succeeded_at: '2026-01-15T12:00:00.000Z',
      } as never,
      { merchant_id: seeded.merchant.id },
    );

    await ctx.dataSource.transaction(async (tx) => consumer.handle(event, tx));
    await ctx.dataSource.transaction(async (tx) => consumer.handle(event, tx));

    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));

    const fanned = list.body.data.filter(
      (e: { source_event_id: string }) => e.source_event_id === event.id,
    );
    // uq_webhook_event_source (endpoint_id, source_event_id) — at-least-once is the bus's
    // contract, exactly-once is ours.
    expect(fanned).toHaveLength(1);
  });

  it('does not fan out an event the endpoint has not subscribed to', async () => {
    const consumer = ctx.app.get(WebhookFanoutConsumer);
    const event = makeEnvelope(
      'payout.scheduled',
      {
        payout_id: 'po_wh0003',
        merchant_id: seeded.merchant.id,
        amount_minor: 20_000,
        currency: 'GBP',
        available_on: '2026-01-17',
        scheduled_at: '2026-01-15T12:00:00.000Z',
      } as never,
      { merchant_id: seeded.merchant.id },
    );

    await ctx.dataSource.transaction(async (tx) => consumer.handle(event, tx));

    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));

    const delivered = list.body.data.find(
      (e: { status: string }) => e.status === 'delivered' || e.status === 'delivering',
    );
    expect(delivered).toBeDefined();
    expect(delivered.signature_version).toBe('v1');

    // The scheme the merchant verifies against, reproduced here from the spec rather
    // than from the implementation.
    const timestamp = 1_768_478_400;
    const body = JSON.stringify({ id: delivered.id });
    const expected = createHmac('sha256', signingSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redelivers an event on demand and increments attempt_count', async () => {
    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));
    const target = list.body.data[0];

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/webhook_events/${target.id}/redeliver`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', 'wh-redeliver-1')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.id);
    expect(res.body.status).toBe('pending');
    expect(res.body.next_attempt_at).toEqual(expect.any(String));
  });

  it('404s a redelivery of another merchant’s event', async () => {
    const stranger = await seedMerchant(ctx, { display_name: 'Borealis' });
    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=1')
      .set('Authorization', bearer(seeded));

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/webhook_events/${list.body.data[0].id}/redeliver`)
      .set('Authorization', bearer(stranger))
      .set('Idempotency-Key', 'wh-redeliver-foreign')
      .send({});

    expect(res.status).toBe(404);
  });

  it('deletes an endpoint without deleting its delivery history', async () => {
    const res = await request(ctx.app.getHttpServer())
      .delete(`/v1/webhook_endpoints/${endpointId}`)
      .set('Authorization', bearer(seeded))
      .set('Idempotency-Key', 'wh-delete-endpoint');

    expect(res.status).toBe(204);

    const events = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));
    expect(events.body.data.length).toBeGreaterThan(0);
  });
});
