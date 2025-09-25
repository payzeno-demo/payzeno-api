import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';

import { ProcessedEventRetentionJob } from './processed-event-retention.job';

describe('ProcessedEventRetentionJob', () => {
  const now = new Date('2026-05-04T03:00:00.000Z');
  const cutoff = new Date('2026-04-04T03:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  let deletions: number[];
  let processedEvents: { retentionCutoff: jest.Mock; deleteOlderThan: jest.Mock };
  let job: ProcessedEventRetentionJob;

  beforeEach(() => {
    jest.clearAllMocks();
    deletions = [1_000, 1_000, 250, 0];

    processedEvents = {
      retentionCutoff: jest.fn(() => cutoff),
      deleteOlderThan: jest.fn(async () => deletions.shift() ?? 0),
    };

    job = new ProcessedEventRetentionJob(
      processedEvents as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  });

  it('deletes in bounded chunks until the table is clean', async () => {
    const result = await job.runOnce();

    expect(processedEvents.deleteOlderThan).toHaveBeenCalledWith(cutoff, 1_000);
    expect(result.processed).toBe(2_250);
    expect(result.truncated).toBe(false);
  });

  it('stops at the per-run cap and reports truncated', async () => {
    deletions = Array.from({ length: 10 }, () => 1_000);

    const result = await job.runOnce();

    expect(result.processed).toBe(5_000);
    expect(result.truncated).toBe(true);
  });

  it('derives the cutoff from the repository, not from a literal here', async () => {
    await job.runOnce();

    expect(processedEvents.retentionCutoff).toHaveBeenCalledWith(now);
    expect(logger.info).toHaveBeenCalledWith(
      'processed_event.purged',
      expect.objectContaining({ cutoff: cutoff.toISOString() }),
    );
  });

  it('is a no-op on an already-clean table', async () => {
    deletions = [0];

    const result = await job.runOnce();

    expect(result.processed).toBe(0);
    expect(processedEvents.deleteOlderThan).toHaveBeenCalledTimes(1);
  });

  it('skips when another task holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('processed-event-retention', 1_800);

    const result = await new ProcessedEventRetentionJob(
      processedEvents as never,
      { now: () => now } as never,
      lock,
      logger as never,
    ).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(processedEvents.deleteOlderThan).not.toHaveBeenCalled();
  });
});
