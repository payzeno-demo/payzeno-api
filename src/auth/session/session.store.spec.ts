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

  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: 'sess_aaa',
      kind: 'merchant_user',
      userId: 'usr_01HQ8ZZZ0000000000000009',
      merchantId: 'mch_01HQ8ZZZ0000000000000001',
      role: 'admin',
      staffId: null,
      staffRole: null,
      csrfToken: 'csrf-token',
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      userAgent: 'Mozilla/5.0',
      ip: '203.0.113.7',
      ...overrides,
    };
  }

  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
    jest.useRealTimers();
  });

  it('returns a record it created', async () => {
    const rec = record();
    await store.create(rec, TTL);

    await expect(store.get('sess_aaa')).resolves.toEqual(rec);
  });

  it('returns null for an unknown session', async () => {
    await expect(store.get('sess_nope')).resolves.toBeNull();
  });

  it('expires a record once its TTL has passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    await store.create(record(), TTL);

    jest.setSystemTime(new Date('2026-01-15T12:01:01.000Z'));

    await expect(store.get('sess_aaa')).resolves.toBeNull();
  });

  it('slides the TTL on touch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
    await store.create(record(), TTL);

    jest.setSystemTime(new Date('2026-01-15T12:00:50.000Z'));
    await store.touch('sess_aaa', TTL);

    jest.setSystemTime(new Date('2026-01-15T12:01:30.000Z'));

    // Still alive: the touch moved the expiry to 12:01:50.
    await expect(store.get('sess_aaa')).resolves.not.toBeNull();
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

  it('destroys a session', async () => {
    await store.create(record(), TTL);
    await store.destroy('sess_aaa');

    await expect(store.get('sess_aaa')).resolves.toBeNull();
  });

  it('is idempotent on a repeated destroy — logout twice is not an error', async () => {
    await store.destroy('sess_aaa');
    await expect(store.destroy('sess_aaa')).resolves.toBeUndefined();
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

  describe('subjectOf', () => {
    it('is the user id for a merchant session', () => {
      expect(subjectOf(record())).toBe('usr_01HQ8ZZZ0000000000000009');
    });

    it('is the staff id for a staff session', () => {
      expect(
        subjectOf(record({ kind: 'staff', userId: null, staffId: 'stf_0001', staffRole: 'risk' })),
      ).toBe('stf_0001');
    });

    it('degrades to "unknown" rather than throwing on a malformed record', () => {
      expect(subjectOf(record({ userId: null }))).toBe('unknown');
    });
  });
});
