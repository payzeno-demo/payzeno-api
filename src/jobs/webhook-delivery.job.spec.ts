import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';
import type { WebhookEndpointEntity } from '../webhooks/webhook-endpoint.entity';
import type { WebhookEventEntity } from '../webhooks/webhook-event.entity';

import { WebhookDeliveryJob } from './webhook-delivery.job';

describe('WebhookDeliveryJob', () => {
  const now = new Date('2026-05-02T10:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function event(overrides: Partial<WebhookEventEntity> = {}): WebhookEventEntity {
    return {
      id: 'evt_1',
      merchantId: 'mch_1',
      endpointId: 'we_1',
      type: 'payout.failed',
      attemptCount: 0,
      ...overrides,
    } as unknown as WebhookEventEntity;
  }

  const endpoint = { id: 'we_1', url: 'https://merchant.example/hooks' } as WebhookEndpointEntity;

  let events: {
    claimDue: jest.Mock;
    markDelivered: jest.Mock;
    markRetrying: jest.Mock;
    markDead: jest.Mock;
  };
  let endpoints: { findOne: jest.Mock };
  let endpointsService: { disableStale: jest.Mock; recordDeliveryOutcome: jest.Mock };
  let strategy: { name: string; deliver: jest.Mock; sign: jest.Mock };
  let job: WebhookDeliveryJob;

  function build(): WebhookDeliveryJob {
    return new WebhookDeliveryJob(
      events as never,
      endpoints as never,
      endpointsService as never,
      [strategy] as never,
      { webhooks: { maxAttempts: 5, retryWindowHours: 24 } } as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    events = {
      claimDue: jest.fn(async () => [event()]),
      markDelivered: jest.fn(async () => undefined),
      markRetrying: jest.fn(async () => undefined),
      markDead: jest.fn(async () => undefined),
    };
    endpoints = { findOne: jest.fn(async () => endpoint) };
    endpointsService = {
      disableStale: jest.fn(async () => []),
      recordDeliveryOutcome: jest.fn(async () => undefined),
    };
    strategy = {
      name: 'http-json',
      deliver: jest.fn(async () => ({
        delivered: true,
        responseStatus: 200,
        error: null,
        durationMs: 42,
        nextAttemptAt: null,
      })),
      sign: jest.fn(() => 'sig'),
    };
    job = build();
  });

  it('marks a 2xx delivery delivered and records the endpoint success', async () => {
    const result = await job.runOnce();

    expect(events.markDelivered).toHaveBeenCalledWith('evt_1', 200, now);
    expect(endpointsService.recordDeliveryOutcome).toHaveBeenCalledWith('we_1', true);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('schedules a retry with backoff on a 500', async () => {
    strategy.deliver.mockResolvedValueOnce({
      delivered: false,
      responseStatus: 500,
      error: 'upstream error',
      durationMs: 10,
      nextAttemptAt: null,
    });

    await job.runOnce();

    expect(events.markRetrying).toHaveBeenCalledWith(
      'evt_1',
      1,
      expect.any(Date),
      500,
      'upstream error',
    );
    const [, , nextAttemptAt] = events.markRetrying.mock.calls[0];
    expect((nextAttemptAt as Date).getTime()).toBeGreaterThan(now.getTime());
  });

  it('kills the event immediately on 410 Gone — no retry budget', async () => {
    strategy.deliver.mockResolvedValueOnce({
      delivered: false,
      responseStatus: 410,
      error: null,
      durationMs: 5,
      nextAttemptAt: null,
    });

    await job.runOnce();

    expect(events.markDead).toHaveBeenCalledWith('evt_1', 1, 410, 'endpoint returned 410 Gone');
    expect(events.markRetrying).not.toHaveBeenCalled();
  });

  it('kills the event once the attempt budget is exhausted', async () => {
    events.claimDue.mockResolvedValueOnce([event({ attemptCount: 4 })]);
    strategy.deliver.mockResolvedValueOnce({
      delivered: false,
      responseStatus: 503,
      error: 'unavailable',
      durationMs: 5,
      nextAttemptAt: null,
    });

    await job.runOnce();

    expect(events.markDead).toHaveBeenCalledWith('evt_1', 5, 503, 'unavailable');
  });

  it('parks an event whose endpoint was deleted between fanout and delivery', async () => {
    endpoints.findOne.mockResolvedValueOnce(null);

    const result = await job.runOnce();

    expect(events.markDead).toHaveBeenCalledWith('evt_1', 0, null, 'endpoint_deleted');
    expect(strategy.deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('disables endpoints that have been failing for 72h at the end of the pass', async () => {
    endpointsService.disableStale.mockResolvedValueOnce(['we_9', 'we_10']);

    const result = await job.runOnce();

    expect(endpointsService.disableStale).toHaveBeenCalledWith(20, 20);
    expect(result.details).toMatchObject({ endpoints_disabled: 2 });
  });
});
