import { keepsRawBody } from './raw-body';

describe('keepsRawBody', () => {
  it('keeps the bytes for the acquirer webhook route ProcessorWebhookController serves', () => {
    expect(keepsRawBody('/v1/processor/webhooks/worldflow')).toBe(true);
    expect(keepsRawBody('/v1/processor/webhooks/nordpay?attempt=2')).toBe(true);
  });

  it('does not hold a copy of every other body in memory', () => {
    expect(keepsRawBody('/v1/payment_intents')).toBe(false);
    expect(keepsRawBody('/v1/webhook_endpoints')).toBe(false);
    expect(keepsRawBody(undefined)).toBe(false);
  });
});
