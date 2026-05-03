import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import { WebhookEventEntity } from '../webhook-event.entity';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';
import { HttpJsonDeliveryStrategy } from './http-json.strategy';
import { SIGNATURE_HEADER } from './delivery.types';

const request = jest.fn();
jest.mock('undici', () => ({ request: (...args: unknown[]) => request(...args) }));

describe('HttpJsonDeliveryStrategy', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const unix = Math.floor(now.getTime() / 1000);

  let secrets: { signingMaterial: jest.Mock };
  let strategy: HttpJsonDeliveryStrategy;

  function endpoint(overrides: Partial<WebhookEndpointEntity> = {}): WebhookEndpointEntity {
    return {
      id: 'whe_live_1',
      merchantId: 'mer_1',
      url: 'https://merchant.example.com/hooks/payzeno',
      ...overrides,
    } as WebhookEndpointEntity;
  }

  function event(overrides: Partial<WebhookEventEntity> = {}): WebhookEventEntity {
    return Object.assign(new WebhookEventEntity(), {
      id: 'evt_1',
      merchantId: 'mer_1',
      endpointId: 'whe_live_1',
      type: 'payment.captured',
      sourceEventId: 'bus_1',
      payload: { id: 'ch_1', amount_minor: 4200, currency: 'USD' },
      status: 'pending',
      attemptCount: 0,
      livemode: true,
      createdAt: now,
      ...overrides,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = { signingMaterial: jest.fn(async () => ({ current: 'whsec_a', previous: null })) };
    strategy = new HttpJsonDeliveryStrategy(
      secrets as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      logger as never,
    );
    respond(200);
  });

  it('posts the serialized event as JSON', async () => {
    const evt = event();

    const result = await strategy.deliver(evt, endpoint());

    expect(result.delivered).toBe(true);
    expect(result.responseStatus).toBe(200);
    expect(result.error).toBeNull();

    const [url, options] = request.mock.calls[0] as [string, Record<string, never>];
    expect(url).toBe('https://merchant.example.com/hooks/payzeno');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(evt.serialize());
    expect((options.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('signs HMAC-SHA256 over "{timestamp}.{body}", not over the body alone', async () => {
    const evt = event();
    const expected = createHmac('sha256', 'whsec_a')
      .update(`${unix}.${evt.serialize()}`)
      .digest('hex');

    await strategy.deliver(evt, endpoint());

    const headers = (request.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers[SIGNATURE_HEADER.toLowerCase()]).toBe(`t=${unix},v1=${expected}`);
    // The naive version signed just the body, which lets anyone replay a captured request
    // forever. The timestamp is what makes the five-minute tolerance mean anything.
    expect(headers[SIGNATURE_HEADER.toLowerCase()]).not.toContain(
      createHmac('sha256', 'whsec_a').update(evt.serialize()).digest('hex'),
    );
  });

  it('sends both signatures during a rotation overlap', async () => {
    secrets.signingMaterial.mockResolvedValue({ current: 'whsec_new', previous: 'whsec_old' });
    const evt = event();

    await strategy.deliver(evt, endpoint());

    const headers = (request.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    const header = headers[SIGNATURE_HEADER.toLowerCase()];
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(header).toContain(
      createHmac('sha256', 'whsec_old').update(`${unix}.${evt.serialize()}`).digest('hex'),
    );
  });

  it('advertises the attempt number the merchant is seeing', async () => {
    await strategy.deliver(event({ attemptCount: 3 }), endpoint());

    const headers = (request.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['payzeno-delivery-attempt']).toBe('4');
    expect(headers['payzeno-event-id']).toBe('evt_1');
    expect(headers['payzeno-event-type']).toBe('payment.captured');
  });

  it('drains the response body so undici releases the socket', async () => {
    const text = jest.fn(async () => '<html>'.repeat(10_000));
    request.mockResolvedValue({ statusCode: 200, body: { text } });

    await strategy.deliver(event(), endpoint());

    expect(text).toHaveBeenCalledTimes(1);
  });

  it('treats a non-2xx as an undelivered attempt without throwing', async () => {
    respond(500, 'upstream boom');

    const result = await strategy.deliver(event(), endpoint());

    expect(result.delivered).toBe(false);
    expect(result.responseStatus).toBe(500);
    expect(result.error).toBe('endpoint responded 500');
  });

  it('leaves nextAttemptAt to the job', async () => {
    respond(503);

    const result = await strategy.deliver(event(), endpoint());

    expect(result.nextAttemptAt).toBeNull();
  });
});
