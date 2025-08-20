import { InMemorySessionStore, subjectOf, type SessionRecord } from 'src/auth/session/session.store';

/**
 * `SessionStore` contract, run against `InMemorySessionStore`.
 *
 * `RedisSessionStore` has its own spec against a real client; this one pins the semantics the
 * two must agree on, because the in-memory store is the one the e2e suite logs in through and
 * a divergence there means every e2e assertion about sessions is testing something production
 * does not do.
 */
describe('InMemorySessionStore', () => {
  const TTL = 60;

  beforeEach(() => {
    store = new InMemorySessionStore();
    jest.useRealTimers();
  });

  it('records lastSeenAt on touch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    await store.create(record(), TTL);

    jest.setSystemTime(new Date('2026-01-15T12:00:30.000Z'));
    await store.touch('sess_aaa', TTL);

    const held = await store.get('sess_aaa');
    expect(held?.lastSeenAtMs).toBe(new Date('2026-01-15T12:00:30.000Z').getTime());
  });

  it('ignores a touch on a session that no longer exists', async () => {
    await expect(store.touch('sess_gone', TTL)).resolves.toBeUndefined();
  });

  describe('destroyAllForUser', () => {
    it('removes every session that user holds and reports the count', async () => {
      await store.create(record({ id: 'sess_a' }), TTL);
      await store.create(record({ id: 'sess_b' }), TTL);
      await store.create(record({ id: 'sess_c', userId: 'usr_someone_else' }), TTL);

      await expect(store.destroyAllForUser('usr_01HQ8ZZZ0000000000000009')).resolves.toBe(2);
      await expect(store.get('sess_a')).resolves.toBeNull();
      await expect(store.get('sess_c')).resolves.not.toBeNull();
    });

    it('is what a password reset calls — a reset that leaves a session resets nothing', async () => {
      await store.create(record({ id: 'sess_attacker' }), TTL);

      await store.destroyAllForUser('usr_01HQ8ZZZ0000000000000009');

      await expect(store.get('sess_attacker')).resolves.toBeNull();
    });

    it('returns 0 when the user holds none', async () => {
      await expect(store.destroyAllForUser('usr_nobody')).resolves.toBe(0);
    });
  });

});
