import type { Redis } from 'ioredis';

import { InMemoryLock } from 'src/common/lock/distributed-lock';
import type { DistributedLock } from 'src/common/lock/distributed-lock';
import { NoopLogger } from 'src/common/logging/logger';
import { RedisLockService } from 'src/common/lock/redis-lock.service';

/**
 * `SET NX PX` with a fencing token, released by a Lua compare-and-act.
 *
 * The compare is not decoration. A plain `DEL` after a `GET` deletes somebody else's lease
 * when our own expired between the two commands — which is how two tasks ended up draining
 * the outbox on the same tick in month 4.
 */
describe('RedisLockService', () => {
  let store: Map<string, string>;
  let redis: jest.Mocked<Pick<Redis, 'set' | 'eval'>>;
  let lock: RedisLockService;

  beforeEach(() => {
    store = new Map();

    redis = {
      set: jest.fn(async (key: string, value: string, ..._rest: unknown[]) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      eval: jest.fn(async (script: string, _n: number, key: string, token: string) => {
        if (store.get(key) !== token) return 0;
        if (script.includes('DEL')) {
          store.delete(key);
        }
        return 1;
      }),
    } as unknown as jest.Mocked<Pick<Redis, 'set' | 'eval'>>;

    lock = new RedisLockService(redis as unknown as Redis, new NoopLogger());
  });

  describe('acquire', () => {
    it('returns a handle when the key is free', async () => {
      const handle = await lock.acquire('outbox-drain', 30);

      expect(handle).not.toBeNull();
      expect(handle?.name).toBe('outbox-drain');
      expect(handle?.token).toEqual(expect.any(String));
    });

    it('uses SET … NX PX so the write is atomic', async () => {
      await lock.acquire('outbox-drain', 30);

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('outbox-drain'),
        expect.any(String),
        'PX',
        30_000,
        'NX',
      );
    });

    it('returns null when another task already holds the lease', async () => {
      await lock.acquire('outbox-drain', 30);

      await expect(lock.acquire('outbox-drain', 30)).resolves.toBeNull();
    });

    it('mints a distinct token per acquisition', async () => {
      const a = await lock.acquire('job-a', 30);
      const b = await lock.acquire('job-b', 30);

      expect(a?.token).not.toBe(b?.token);
    });

    it('reports when the lease expires', async () => {
      const before = Date.now();
      const handle = await lock.acquire('outbox-drain', 30);

      expect(handle!.expiresAtMs).toBeGreaterThanOrEqual(before + 29_000);
    });

    it('namespaces the key so two jobs with similar names do not collide', async () => {
      await lock.acquire('drain', 30);
      const key = redis.set.mock.calls[0][0] as string;

      expect(key).not.toBe('drain');
      expect(key).toContain('drain');
    });
  });

  describe('release', () => {
    it('releases a lease we still hold', async () => {
      const handle = await lock.acquire('outbox-drain', 30);

      await expect(lock.release(handle!)).resolves.toBe(true);
      await expect(lock.acquire('outbox-drain', 30)).resolves.not.toBeNull();
    });

    it('compares the token before deleting', async () => {
      const handle = await lock.acquire('outbox-drain', 30);

      await lock.release(handle!);

      const [script] = redis.eval.mock.calls[0];
      expect(String(script)).toContain('GET');
      expect(String(script)).toContain('DEL');
    });

    it('does not delete a lease taken over by someone else', async () => {
      const handle = await lock.acquire('outbox-drain', 30);
      // Our lease lapsed and another task claimed the key.
      store.set(Object.keys(Object.fromEntries(store))[0], 'someone-elses-token');

      await expect(lock.release(handle!)).resolves.toBe(false);
      expect(store.size).toBe(1);
    });

    it('reports false rather than throwing when the key is gone', async () => {
      const handle = await lock.acquire('outbox-drain', 30);
      store.clear();

      await expect(lock.release(handle!)).resolves.toBe(false);
    });
  });

  describe('extend', () => {
    it('extends a lease we still hold', async () => {
      const handle = await lock.acquire('webhook-delivery', 15);

      await expect(lock.extend(handle!, 30)).resolves.toBe(true);
    });

    it('refuses to extend a lease we no longer hold', async () => {
      const handle = await lock.acquire('webhook-delivery', 15);
      store.clear();

      await expect(lock.extend(handle!, 30)).resolves.toBe(false);
    });

    it('uses PEXPIRE rather than re-SETting the key', async () => {
      const handle = await lock.acquire('webhook-delivery', 15);
      await lock.extend(handle!, 30);

      expect(String(redis.eval.mock.calls[0][0])).toContain('PEXPIRE');
    });
  });
});

describe('InMemoryLock', () => {
  let lock: DistributedLock;

  beforeEach(() => {
    lock = new InMemoryLock();
  });

  it('satisfies the same interface — the single-task dev seam', async () => {
    const handle = await lock.acquire('job', 30);

    expect(handle).not.toBeNull();
    await expect(lock.release(handle!)).resolves.toBe(true);
  });

  it('refuses a second acquisition while held', async () => {
    await lock.acquire('job', 30);

    await expect(lock.acquire('job', 30)).resolves.toBeNull();
  });

  it('allows re-acquisition after release', async () => {
    const handle = await lock.acquire('job', 30);
    await lock.release(handle!);

    await expect(lock.acquire('job', 30)).resolves.not.toBeNull();
  });

  it('refuses to release a handle it does not recognise', async () => {
    await lock.acquire('job', 30);

    await expect(
      lock.release({ name: 'job', token: 'wrong', expiresAtMs: Date.now() + 1_000 }),
    ).resolves.toBe(false);
  });
});
