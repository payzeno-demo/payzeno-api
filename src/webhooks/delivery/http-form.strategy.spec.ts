import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import { WebhookEventEntity } from '../webhook-event.entity';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';
import { HttpFormDeliveryStrategy } from './http-form.strategy';
import { SIGNATURE_HEADER } from './delivery.types';

const request = jest.fn();
jest.mock('undici', () => ({ request: (...args: unknown[]) => request(...args) }));

/** Decode the form body back into a flat map so assertions read like the wire. */
function decode(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [key, value] = pair.split('=');
    out[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
  }
  return out;
}

describe('HttpFormDeliveryStrategy', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const unix = Math.floor(now.getTime() / 1000);

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  let secrets: { signingMaterial: jest.Mock };
  let strategy: HttpFormDeliveryStrategy;

  function endpoint(): WebhookEndpointEntity {
    return {
      id: 'whe_form_1',
      merchantId: 'mer_legacy',
      url: 'https://legacy.example.com/payzeno?format=form',
    } as WebhookEndpointEntity;
  }

  function event(payload: Record<string, unknown>): WebhookEventEntity {
    return Object.assign(new WebhookEventEntity(), {
      id: 'evt_form_1',
      merchantId: 'mer_legacy',
      endpointId: 'whe_form_1',
      type: 'payment.captured',
      sourceEventId: 'bus_9',
      payload,
      status: 'pending',
      attemptCount: 0,
      livemode: true,
      createdAt: now,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = { signingMaterial: jest.fn(async () => ({ current: 'whsec_f', previous: null })) };
    strategy = new HttpFormDeliveryStrategy(
      secrets as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      logger as never,
    );
    request.mockResolvedValue({ statusCode: 200, body: { text: jest.fn(async () => 'OK') } });
  });

  it('sends form-encoded, never JSON', async () => {
    await strategy.deliver(event({ id: 'ch_1' }), endpoint());

    const options = request.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(options.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(() => JSON.parse(options.body)).toThrow();
  });

  it('flattens nested payloads to dotted keys under data.object', async () => {
    await strategy.deliver(
      event({ id: 'ch_1', amount_minor: 4200, card: { brand: 'visa', last_four: '4242' } }),
      endpoint(),
    );

    const form = decode((request.mock.calls[0][1] as { body: string }).body);
    expect(form['data.object.id']).toBe('ch_1');
    expect(form['data.object.amount_minor']).toBe('4200');
    expect(form['data.object.card.brand']).toBe('visa');
    expect(form['data.object.card.last_four']).toBe('4242');
  });

  it('indexes arrays the way http_build_query does, because that is what they parse', async () => {
    await strategy.deliver(
      event({ lines: [{ amount_minor: 100 }, { amount_minor: 250 }] }),
      endpoint(),
    );

    const form = decode((request.mock.calls[0][1] as { body: string }).body);
    expect(form['data.object.lines.0.amount_minor']).toBe('100');
    expect(form['data.object.lines.1.amount_minor']).toBe('250');
  });

  it('renders null as an empty value rather than the string "null"', async () => {
    await strategy.deliver(event({ failure_code: null, id: 'ch_2' }), endpoint());

    const form = decode((request.mock.calls[0][1] as { body: string }).body);
    expect(form['data.object.failure_code']).toBe('');
  });

  it('carries the envelope fields alongside the flattened payload', async () => {
    await strategy.deliver(event({ id: 'ch_3' }), endpoint());

    const form = decode((request.mock.calls[0][1] as { body: string }).body);
    expect(form.id).toBe('evt_form_1');
    expect(form.type).toBe('payment.captured');
    expect(form.livemode).toBe('true');
    expect(form.created).toBe(String(unix));
  });

  it('signs the encoded form body, not the JSON serialization', async () => {
    const evt = event({ id: 'ch_4' });

    await strategy.deliver(evt, endpoint());

    const options = request.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    const expected = createHmac('sha256', 'whsec_f')
      .update(`${unix}.${options.body}`)
      .digest('hex');
    expect(options.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(`t=${unix},v1=${expected}`);
    // If we ever signed `evt.serialize()` here the three remaining integrations would all
    // start rejecting on signature mismatch at once, which is how this test got written.
    expect(options.headers[SIGNATURE_HEADER.toLowerCase()]).not.toContain(
      createHmac('sha256', 'whsec_f').update(`${unix}.${evt.serialize()}`).digest('hex'),
    );
  });

  it('percent-encodes values that would otherwise break the body', async () => {
    await strategy.deliver(event({ description: 'coffee & cake = 5' }), endpoint());

    const body = (request.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain('coffee%20%26%20cake%20%3D%205');
    expect(decode(body)['data.object.description']).toBe('coffee & cake = 5');
  });

  it('reports a transport failure with its strategy name in the log context', async () => {
    request.mockRejectedValue(new Error('socket hang up'));

    const result = await strategy.deliver(event({ id: 'ch_5' }), endpoint());

    expect(result.delivered).toBe(false);
    expect(result.responseStatus).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'webhook.delivery_transport_error',
      expect.objectContaining({ strategy: 'http-form' }),
    );
  });
});
