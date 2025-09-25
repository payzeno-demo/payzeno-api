import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';
import type { EventOutbox } from '../events/event-outbox.entity';

import { OutboxDrainJob } from './outbox-drain.job';

describe('OutboxDrainJob', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function row(id: string, attemptCount = 0): EventOutbox {
    return {
      id,
      type: 'payment.authorized',
      version: 1,
      payload: { charge_id: 'ch_1' },
      merchantId: 'mch_1',
      correlationId: 'corr_1',
      causationId: null,
      livemode: true,
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      publishedAt: null,
      attemptCount,
      nextAttemptAt: new Date('2026-05-01T00:00:00.000Z'),
      claimedAt: null,
      claimedBy: null,
      deadAt: null,
      lastError: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      isDeliverable: () => true,
    } as unknown as EventOutbox;
  }

  let outbox: {
    claimDue: jest.Mock;
    markPublished: jest.Mock;
    markFailed: jest.Mock;
  };
  let bus: { publishBatch: jest.Mock };
  let job: OutboxDrainJob;

  beforeEach(() => {
    jest.clearAllMocks();
    outbox = {
      claimDue: jest.fn(async () => [row('evt_1'), row('evt_2')]),
      markPublished: jest.fn(async (ids: string[]) => ids.length),
      markFailed: jest.fn(async () => 'retrying' as const),
    };
    bus = { publishBatch: jest.fn(async (events: Array<{ id: string }>) => events.map((e) => e.id)) };

    job = new OutboxDrainJob(outbox as never, bus as never, new InMemoryLock(), logger as never);
  });

  it('publishes the claimed page in one batch and marks it published', async () => {
    const result = await job.runOnce();

    expect(bus.publishBatch).toHaveBeenCalledTimes(1);
    expect(outbox.markPublished).toHaveBeenCalledWith(['evt_1', 'evt_2'], expect.any(Date));
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('republishes exactly what the transaction committed — no re-derived version', async () => {
    outbox.claimDue.mockResolvedValueOnce([{ ...row('evt_3'), version: 1, type: 'settlement.completed' }]);

    await job.runOnce();

    const [[envelopes]] = bus.publishBatch.mock.calls;
    expect(envelopes[0]).toMatchObject({
      id: 'evt_3',
      version: 1,
      source: 'payzeno-api',
      correlation_id: 'corr_1',
      occurred_at: '2026-05-01T00:00:00.000Z',
    });
  });

  it('does nothing and claims nothing when the outbox is empty', async () => {
    outbox.claimDue.mockResolvedValueOnce([]);

    const result = await job.runOnce();

    expect(bus.publishBatch).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  describe('when the batch call fails', () => {
    beforeEach(() => {
      bus.publishBatch
        .mockRejectedValueOnce(new Error('InvalidParameter: entry too large'))
        .mockImplementation(async (events: Array<{ id: string }>) =>
          events[0].id === 'evt_1' ? [events[0].id] : Promise.reject(new Error('still bad')),
        );
    });

    it('retries row by row so one bad payload cannot stall the bus', async () => {
      const result = await job.runOnce();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
      expect(outbox.markPublished).toHaveBeenCalledWith(['evt_1'], expect.any(Date));
      expect(outbox.markFailed).toHaveBeenCalledWith('evt_2', 'still bad', expect.any(Date));
    });

    it('escalates a row the drain has given up on', async () => {
      outbox.markFailed.mockResolvedValueOnce('dead');

      const result = await job.runOnce();

      expect(result.details).toMatchObject({ dead: 1 });
      expect(logger.error).toHaveBeenCalledWith(
        'outbox.event_dead',
        expect.any(Error),
        expect.objectContaining({ event_id: 'evt_2' }),
      );
    });
  });

  it('skips entirely when another task holds the drain lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('outbox-drain', 30);

    const result = await new OutboxDrainJob(
      outbox as never,
      bus as never,
      lock,
      logger as never,
    ).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(outbox.claimDue).not.toHaveBeenCalled();
  });
});
