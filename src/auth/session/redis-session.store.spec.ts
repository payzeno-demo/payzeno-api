import type { Redis } from 'ioredis';

import { RedisSessionStore } from 'src/auth/session/redis-session.store';
import type { SessionRecord } from 'src/auth/session/session.store';
import { NoopLogger } from 'src/common/logging/logger';

/**
 * `RedisSessionStore` against a scripted client. The two things worth pinning are the reverse
 * index and the unparseable-record path:
 *
 *   - `sess:user:<id>` is a SET of live session ids, and `destroyAllForUser` walks it. Without
 *     it, a password reset would have to SCAN a shared keyspace on the one code path that must
 *     not be slow — so a change that drops the SET write is a change that silently breaks
 *     revocation, and nothing else in the suite would notice.
 *   - a record that will not parse is dropped and treated as absent. Trusting it would mean
 *     handing a principal to whatever half-written JSON happened to be in the key.
 */
describe('RedisSessionStore', () => {
  const TTL = 43_200;

  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: 'sess_aaa',
      kind: 'merchant_user',
      userId: 'usr_0001',
      merchantId: 'mch_0001',
      role: 'admin',
      staffId: null,
      staffRole: null,
      csrfToken: 'csrf',
      createdAtMs: 1_768_478_400_000,
      lastSeenAtMs: 1_768_478_400_000,
      userAgent: 'Mozilla/5.0',
      ip: '203.0.113.7',
      ...overrides,
    };
  }

  interface Pipeline {
    set: jest.Mock;
    sadd: jest.Mock;
    srem: jest.Mock;
    del: jest.Mock;
    expire: jest.Mock;
    exec: jest.Mock;
  }

  let pipeline: Pipeline;
  let redis: jest.Mocked<Pick<Redis, 'get' | 'smembers' | 'multi'>>;
  let store: RedisSessionStore;

  beforeEach(() => {
    pipeline = {
      set: jest.fn(() => pipeline),
      sadd: jest.fn(() => pipeline),
      srem: jest.fn(() => pipeline),
      del: jest.fn(() => pipeline),
      expire: jest.fn(() => pipeline),
      exec: jest.fn(async () => []),
    };

    redis = {
      get: jest.fn(async () => null),
      smembers: jest.fn(async () => []),
      multi: jest.fn(() => pipeline),
    } as never;

    store = new RedisSessionStore(redis as unknown as Redis, new NoopLogger());
  });

  describe('create', () => {
    it('writes the record under sess:<id> with the session TTL', async () => {
      await store.create(record(), TTL);

      expect(pipeline.set).toHaveBeenCalledWith(
        'sess:sess_aaa',
        JSON.stringify(record()),
        'EX',
        TTL,
      );
    });

    it('adds the session to the user reverse index', async () => {
      await store.create(record(), TTL);

      expect(pipeline.sadd).toHaveBeenCalledWith('sess:user:usr_0001', 'sess_aaa');
      expect(pipeline.expire).toHaveBeenCalledWith('sess:user:usr_0001', TTL);
    });

    it('indexes a staff session under its staff id', async () => {
      await store.create(
        record({ kind: 'staff', userId: null, staffId: 'stf_0001', staffRole: 'risk' }),
        TTL,
      );

      expect(pipeline.sadd).toHaveBeenCalledWith('sess:user:stf_0001', 'sess_aaa');
    });

    it('does both writes in one MULTI — a half-created session is unrevokable', async () => {
      await store.create(record(), TTL);

      expect(redis.multi).toHaveBeenCalledTimes(1);
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('parses the stored record', async () => {
      redis.get.mockResolvedValue(JSON.stringify(record()));

      await expect(store.get('sess_aaa')).resolves.toEqual(record());
    });

    it('is null for a missing key', async () => {
      await expect(store.get('sess_aaa')).resolves.toBeNull();
    });

    it('drops and reports null for an unparseable record', async () => {
      redis.get.mockResolvedValue('{"id":"sess_aaa"');

      await expect(store.get('sess_aaa')).resolves.toBeNull();
      expect(pipeline.del).toHaveBeenCalledWith('sess:sess_aaa');
    });
  });

  describe('touch', () => {
    it('rewrites the record with a fresh TTL and a new lastSeenAt', async () => {
      redis.get.mockResolvedValue(JSON.stringify(record()));

      await store.touch('sess_aaa', TTL);

      const [, json] = pipeline.set.mock.calls[0];
      expect(JSON.parse(json as string).lastSeenAtMs).toBeGreaterThan(record().lastSeenAtMs);
    });

    it('slides the reverse index too, or the SET expires first', async () => {
      redis.get.mockResolvedValue(JSON.stringify(record()));

      await store.touch('sess_aaa', TTL);

      expect(pipeline.expire).toHaveBeenCalledWith('sess:user:usr_0001', TTL);
    });

    it('does nothing for an unknown session', async () => {
      await store.touch('sess_gone', TTL);

      expect(pipeline.set).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('deletes the record and removes it from the reverse index', async () => {
      redis.get.mockResolvedValue(JSON.stringify(record()));

      await store.destroy('sess_aaa');

      expect(pipeline.del).toHaveBeenCalledWith('sess:sess_aaa');
      expect(pipeline.srem).toHaveBeenCalledWith('sess:user:usr_0001', 'sess_aaa');
    });

    it('still deletes the key when the record has already gone', async () => {
      await store.destroy('sess_aaa');

      expect(pipeline.del).toHaveBeenCalledWith('sess:sess_aaa');
      expect(pipeline.srem).not.toHaveBeenCalled();
    });
  });

  describe('destroyAllForUser', () => {
    it('deletes every indexed session and the index itself', async () => {
      redis.smembers.mockResolvedValue(['sess_a', 'sess_b']);

      await expect(store.destroyAllForUser('usr_0001')).resolves.toBe(2);

      expect(pipeline.del).toHaveBeenCalledWith('sess:sess_a');
      expect(pipeline.del).toHaveBeenCalledWith('sess:sess_b');
      expect(pipeline.del).toHaveBeenCalledWith('sess:user:usr_0001');
    });

    it('short-circuits when the user holds none', async () => {
      await expect(store.destroyAllForUser('usr_0001')).resolves.toBe(0);

      expect(redis.multi).not.toHaveBeenCalled();
    });
  });
});
