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
  function endpoint(): WebhookEndpointEntity {
    return {
      id: 'whe_form_1',
      merchantId: 'mer_legacy',
      url: 'https://legacy.example.com/payzeno?format=form',
    } as WebhookEndpointEntity;
  }

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

});
