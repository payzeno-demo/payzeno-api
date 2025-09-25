import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';
import type { IdempotencyRecord } from '../common/idempotency/idempotency-record.entity';

import { IdempotencyRetentionJob } from './idempotency-retention.job';

describe('IdempotencyRetentionJob', () => {
  const now = new Date('2026-05-03T01:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function record(key: string): IdempotencyRecord {
    return {
      merchantId: 'mch_1',
      livemode: true,
      key,
      state: 'completed',
    } as unknown as IdempotencyRecord;
  }

  let found: IdempotencyRecord[][];
  let deleted: Array<Record<string, unknown>>;
  let updateAffected: number;
  let records: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let job: IdempotencyRetentionJob;

  beforeEach(() => {
    jest.clearAllMocks();
    found = [[record('k1'), record('k2')], []];
    deleted = [];
    updateAffected = 0;

    records = {
      find: jest.fn(async () => found.shift() ?? []),
      createQueryBuilder: jest.fn(() => {
        const builder = {
          update: () => builder,
          set: () => builder,
          where: () => builder,
          andWhere: () => builder,
          execute: async () => ({ affected: updateAffected }),
        };
        return builder;
      }),
    };

    dataSource = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          delete: async (_entity: unknown, criteria: Record<string, unknown>) => {
            deleted.push(criteria);
          },
        }),
      ),
    };

    job = new IdempotencyRetentionJob(
      records as never,
      dataSource as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  });

  it('deletes expired rows by their composite primary key', async () => {
    const result = await job.runOnce();

    expect(deleted).toEqual([
      { merchantId: 'mch_1', livemode: true, key: 'k1' },
      { merchantId: 'mch_1', livemode: true, key: 'k2' },
    ]);
    expect(result.processed).toBe(2);
  });

  it('stops when a short page comes back rather than looping forever', async () => {
    found = [[record('k1')]];

    await job.runOnce();

    expect(records.find).toHaveBeenCalledTimes(1);
  });

  it('reclaims stale in_progress leases as failed, not deleted', async () => {
    updateAffected = 3;
    found = [[]];

    const result = await job.runOnce();

    expect(result.details).toMatchObject({ leases_reclaimed: 3, deleted: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'idempotency.stale_leases_reclaimed',
      expect.objectContaining({ reclaimed: 3 }),
    );
  });

  it('says nothing when there was nothing to reclaim', async () => {
    found = [[]];

    await job.runOnce();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips when another task holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('idempotency-retention', 900);

    const result = await new IdempotencyRetentionJob(
      records as never,
      dataSource as never,
      { now: () => now } as never,
      lock,
      logger as never,
    ).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(records.find).not.toHaveBeenCalled();
  });
});
