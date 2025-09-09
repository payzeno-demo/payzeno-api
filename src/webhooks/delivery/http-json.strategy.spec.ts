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
  function endpoint(overrides: Partial<WebhookEndpointEntity> = {}): WebhookEndpointEntity {
    return {
      id: 'whe_live_1',
      merchantId: 'mer_1',
      url: 'https://merchant.example.com/hooks/payzeno',
      ...overrides,
    } as WebhookEndpointEntity;
  }

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

  it('drains the response body so undici releases the socket', async () => {
    const text = jest.fn(async () => '<html>'.repeat(10_000));
    request.mockResolvedValue({ statusCode: 200, body: { text } });

    await strategy.deliver(event(), endpoint());

    expect(text).toHaveBeenCalledTimes(1);
  });

});
