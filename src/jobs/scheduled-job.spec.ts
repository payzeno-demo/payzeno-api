import 'reflect-metadata';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { InMemoryLock, type DistributedLock, type LockHandle } from '../common/lock/distributed-lock';

import { emptyResult, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

describe('ScheduledJob', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  class LockedJob extends ScheduledJob {
    readonly name = 'locked-job';
    readonly cronExpression = '0 * * * *';
    ran = 0;
    throwOnRun = false;

    constructor(lock: DistributedLock) {
      super(lock, logger as never);
    }

    @JobLock('locked-job', 60)
    async runOnce(): Promise<JobResult> {
      const result = await this.withLock(async () => {
        if (this.throwOnRun) {
          throw new Error('boom');
        }
        this.ran += 1;
        return { ...emptyResult(1), processed: 3 } satisfies JobResult;
      });

      return result ?? this.skipped();
    }
  }

  class UnlockedJob extends ScheduledJob {
    readonly name = 'unlocked-job';
    readonly cronExpression = '0 * * * *';

    constructor(lock: DistributedLock) {
      super(lock, logger as never);
    }

    async runOnce(): Promise<JobResult> {
      const result = await this.withLock(async () => emptyResult(0));
      return result ?? this.skipped();
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs the body when it wins the lease', async () => {
    const job = new LockedJob(new InMemoryLock());

    const result = await job.runOnce();

    expect(job.ran).toBe(1);
    expect(result.processed).toBe(3);
  });

  it('skips with a distinguishable result when another task holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('locked-job', 60);

    const result = await new LockedJob(lock).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(result.processed).toBe(0);
  });

  it('releases the lease even when the body throws', async () => {
    const lock = new InMemoryLock();
    const job = new LockedJob(lock);
    job.throwOnRun = true;

    await expect(job.runOnce()).rejects.toThrow('boom');

    // The lease must be free again, otherwise one exception silences the job for its TTL.
    await expect(lock.acquire('locked-job', 60)).resolves.not.toBeNull();
  });

  it('warns when the lease lapsed before the body finished', async () => {
    const lapsed: DistributedLock = {
      acquire: async (name, ttlSec): Promise<LockHandle> => ({
        name,
        token: 't',
        expiresAtMs: Date.now() + ttlSec * 1000,
      }),
      release: async () => false,
      extend: async () => false,
    };

    await new LockedJob(lapsed).runOnce();

    expect(logger.warn).toHaveBeenCalledWith(
      'job.lease_lapsed',
      expect.objectContaining({ job: 'locked-job', ttl_sec: 60 }),
    );
  });

  it('refuses to run a job whose runOnce has no @JobLock', async () => {
    await expect(new UnlockedJob(new InMemoryLock()).runOnce()).rejects.toThrow(
      /missing @JobLock/,
    );
  });

  describe('execute', () => {
    it('never rejects — a throwing job would take the process down', async () => {
      const job = new LockedJob(new InMemoryLock());
      job.throwOnRun = true;

      const result = await job.execute();

      expect(result.failed).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        'job.failed',
        expect.any(Error),
        expect.objectContaining({ job: 'locked-job' }),
      );
    });

    it('logs one job.finished line per run, whatever the outcome', async () => {
      await new LockedJob(new InMemoryLock()).execute();

      expect(logger.info).toHaveBeenCalledWith(
        'job.finished',
        expect.objectContaining({ job: 'locked-job', processed: 3 }),
      );
    });
  });
});
