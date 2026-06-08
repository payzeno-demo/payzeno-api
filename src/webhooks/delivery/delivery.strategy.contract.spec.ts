import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import { WebhookEventEntity } from '../webhook-event.entity';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';
import {
  selectStrategy,
  strategyNameForUrl,
  type WebhookDeliveryStrategy,
} from './delivery.strategy';
import {
  formatSignatureHeader,
  isPermanentRejection,
  isSuccessStatus,
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
} from './delivery.types';
import { HttpFormDeliveryStrategy } from './http-form.strategy';
import { HttpJsonDeliveryStrategy } from './http-json.strategy';

const request = jest.fn();
jest.mock('undici', () => ({ request: (...args: unknown[]) => request(...args) }));

/**
 * The contract every `WebhookDeliveryStrategy` has to hold, run against BOTH implementations.
 *
 * These are the invariants `WebhookDeliveryJob` depends on. The job does not know which
 * strategy it got — it reads `DeliveryResult` and turns it into a status change — so any
 * disagreement between the two shows up as a merchant whose retries behave differently from
 * everyone else's, which is exactly the class of bug that took three days to find in month 6.
 */
const now = new Date('2026-06-01T12:00:00.000Z');
const unix = Math.floor(now.getTime() / 1000);

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
};

const clock = { now: () => now, nowMs: () => now.getTime() };

function secretsStub(): { signingMaterial: jest.Mock } {
  return { signingMaterial: jest.fn(async () => ({ current: 'whsec_k', previous: null })) };
}

function anEndpoint(url: string): WebhookEndpointEntity {
  return { id: 'whe_1', merchantId: 'mer_1', url } as WebhookEndpointEntity;
}

function anEvent(): WebhookEventEntity {
  return Object.assign(new WebhookEventEntity(), {
    id: 'evt_contract_1',
    merchantId: 'mer_1',
    endpointId: 'whe_1',
    type: 'payment.captured',
    sourceEventId: 'bus_1',
    payload: { id: 'ch_1', amount_minor: 1000, currency: 'USD' },
    status: 'pending',
    attemptCount: 2,
    livemode: true,
    createdAt: now,
  });
}

const implementations: Array<[string, () => WebhookDeliveryStrategy, string]> = [
  [
    'HttpJsonDeliveryStrategy',
    () => new HttpJsonDeliveryStrategy(secretsStub() as never, clock as never, logger as never),
    'https://merchant.example.com/hooks',
  ],
  [
    'HttpFormDeliveryStrategy',
    () => new HttpFormDeliveryStrategy(secretsStub() as never, clock as never, logger as never),
    'https://legacy.example.com/hooks?format=form',
  ],
];

describe('WebhookDeliveryStrategy contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    request.mockResolvedValue({ statusCode: 200, body: { text: jest.fn(async () => 'ok') } });
  });

  describe.each(implementations)('%s', (_name, build, url) => {
    it('declares a name the registry can select on', () => {
      const strategy = build();

      expect(['http-json', 'http-form']).toContain(strategy.name);
      expect(selectStrategy([strategy], strategy.name)).toBe(strategy);
    });

    it('returns a fully populated DeliveryResult on success', async () => {
      const result = await build().deliver(anEvent(), anEndpoint(url));

      expect(result).toEqual({
        delivered: true,
        responseStatus: 200,
        error: null,
        durationMs: expect.any(Number),
        nextAttemptAt: null,
      });
    });

    it('never throws — a dead merchant endpoint is data, not an exception', async () => {
      request.mockRejectedValue(new Error('connect ETIMEDOUT'));

      const result = await build().deliver(anEvent(), anEndpoint(url));

      expect(result.delivered).toBe(false);
      expect(result.responseStatus).toBeNull();
      expect(result.error).toContain('ETIMEDOUT');
    });

    it.each([200, 201, 202, 204])('treats %i as delivered', async (status) => {
      request.mockResolvedValue({ statusCode: status, body: { text: jest.fn(async () => '') } });

      const result = await build().deliver(anEvent(), anEndpoint(url));

      expect(result.delivered).toBe(true);
      expect(isSuccessStatus(status)).toBe(true);
    });

    it.each([301, 400, 401, 404, 410, 429, 500, 503])(
      'treats %i as not delivered but keeps the status for the job',
      async (status) => {
        request.mockResolvedValue({
          statusCode: status,
          body: { text: jest.fn(async () => '') },
        });

        const result = await build().deliver(anEvent(), anEndpoint(url));

        expect(result.delivered).toBe(false);
        expect(result.responseStatus).toBe(status);
        expect(result.error).toBe(`endpoint responded ${status}`);
      },
    );

    it('signs "{timestamp}.{body}" with HMAC-SHA256 over whatever it actually sent', async () => {
      const strategy = build();

      await strategy.deliver(anEvent(), anEndpoint(url));

      const options = request.mock.calls[0][1] as {
        headers: Record<string, string>;
        body: string;
      };
      const expected = strategy.sign(options.body, 'whsec_k', unix);
      expect(expected).toBe(
        createHmac('sha256', 'whsec_k').update(`${unix}.${options.body}`).digest('hex'),
      );
      expect(options.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
        formatSignatureHeader(unix, [expected]),
      );
    });

    it('produces a stable signature for the same body and timestamp', () => {
      const strategy = build();

      expect(strategy.sign('body', 'whsec_k', unix)).toBe(strategy.sign('body', 'whsec_k', unix));
      expect(strategy.sign('body', 'whsec_k', unix)).not.toBe(
        strategy.sign('body', 'whsec_k', unix + 1),
      );
    });

    it('identifies the event on the wire so the merchant can dedupe', async () => {
      await build().deliver(anEvent(), anEndpoint(url));

      const headers = (request.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers['payzeno-event-id']).toBe('evt_contract_1');
      expect(headers['payzeno-event-type']).toBe('payment.captured');
    });

    it('leaves the retry decision to the job', async () => {
      request.mockResolvedValue({ statusCode: 503, body: { text: jest.fn(async () => '') } });

      const result = await build().deliver(anEvent(), anEndpoint(url));

      // A strategy has no retry budget: `webhook_event.attempt_count` is the budget and only
      // the job may touch it.
      expect(result.nextAttemptAt).toBeNull();
    });
  });

  describe('registry helpers', () => {
    it('routes form-marked urls to the form strategy and everything else to JSON', () => {
      expect(strategyNameForUrl('https://legacy.example.com/hook?format=form')).toBe('http-form');
      expect(strategyNameForUrl('https://merchant.example.com/hook')).toBe('http-json');
    });

    it('fails loudly when a strategy is missing rather than silently not delivering', () => {
      const json = new HttpJsonDeliveryStrategy(
        secretsStub() as never,
        clock as never,
        logger as never,
      );

      expect(() => selectStrategy([json], 'http-form')).toThrow(
        'no WebhookDeliveryStrategy registered for "http-form"',
      );
    });

    it('holds the shared 410-is-permanent rule', () => {
      expect(isPermanentRejection(410)).toBe(true);
      expect(isPermanentRejection(404)).toBe(false);
      expect(isPermanentRejection(null)).toBe(false);
    });

    it('keeps the replay tolerance at five minutes', () => {
      expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    });
  });
});
