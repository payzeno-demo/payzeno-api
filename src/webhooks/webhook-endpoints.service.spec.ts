import { WebhookEndpointsService } from './webhook-endpoints.service';

describe('WebhookEndpointsService', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');

  let secrets: { generate: jest.Mock; encrypt: jest.Mock; lastFour: jest.Mock; rotate: jest.Mock };
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  it('rejects an event type outside PUBLIC_EVENT_TYPES', async () => {
    await expect(
      service.create('mer_1', true, {
        ...(dto as object),
        enabled_events: ['settlement.duplicate_detected'],
      } as never),
    ).rejects.toThrow(/unknown event types/);
  });

});
