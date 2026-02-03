import type { EntityManager } from 'typeorm';
import type { PayzenoEvent } from '@payzeno/contracts/events';
import { PUBLIC_EVENT_TYPES } from '@payzeno/contracts';
import { WebhookFanoutConsumer } from './webhook-fanout.consumer';

describe('WebhookFanoutConsumer', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  let endpoints: { listEnabledFor: jest.Mock };
  let consumer: WebhookFanoutConsumer;
  const tx = {} as EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    endpoints = { listEnabledFor: jest.fn(async () => [{ id: 'whe_1' }, { id: 'whe_2' }]) };
    events = { fanout: jest.fn(async () => 2) };

    consumer = new WebhookFanoutConsumer(
      {} as never,
      {} as never,
      {} as never,
      logger as never,
      { SQS_API_WEBHOOKS_URL: 'http://localstack:4566/000000000000/payzeno-api-webhooks' } as never,
      {
        get: (token: unknown) =>
          (token as { name?: string }).name === 'WebhookEndpointsService' ? endpoints : events,
      } as never,
    );
    consumer.onModuleInit();
  });

  it('never handles an internal-only ledger event', () => {
    expect(consumer.handledTypes.has('settlement.duplicate_detected')).toBe(false);
    expect(consumer.handledTypes.has('ledger.imbalance_detected')).toBe(false);
    expect(consumer.handledTypes.has('settlement.batch_closed')).toBe(false);
  });

  it('reports dedupe when the insert conflicts on uq_webhook_event_source', async () => {
    events.fanout.mockResolvedValueOnce(1);

    await consumer.handle(busEvent(), tx);

    expect(logger.info).toHaveBeenCalledWith(
      'webhook.fanned_out',
      expect.objectContaining({ inserted: 1, deduped: 1 }),
    );
  });

  it('does nothing when the merchant has no matching endpoint', async () => {
    endpoints.listEnabledFor.mockResolvedValueOnce([]);

    await consumer.handle(busEvent(), tx);

    expect(events.fanout).not.toHaveBeenCalled();
  });

});
