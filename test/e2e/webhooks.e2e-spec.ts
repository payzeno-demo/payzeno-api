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

    const endpoint = list.body.data.find((e: { id: string }) => e.id === endpointId);
    expect(endpoint.signing_secret).toBeUndefined();
    expect(endpoint.signing_secret_last_four).toEqual(expect.any(String));
  });

  it('fans a bus event out to one webhook_event per subscribed endpoint', async () => {
    const list = await request(ctx.app.getHttpServer())
      .get('/v1/webhook_events?limit=50')
      .set('Authorization', bearer(seeded));

    const consumer = ctx.app.get(WebhookFanoutConsumer);
    const target = list.body.data[0];

    const stranger = await seedMerchant(ctx, { display_name: 'Borealis' });
  });
});
