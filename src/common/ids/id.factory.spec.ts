import { IdFactory, newId } from 'src/common/ids/id.factory';
import {
  ALL_PREFIXES,
  FOREIGN_ID_PREFIXES,
  API_ID_PREFIXES,
  isPayzenoId,
  prefixOf,
} from 'src/common/ids/id.prefix';

/**
 * `<prefix>_<26-char ULID>`, monotonic within a process.
 *
 * The monotonicity is not decoration: `PayzenoRepository.paginateCursor` orders on
 * `(created_at desc, id desc)` and relies on ids from the same millisecond sorting by
 * creation order. A random id would make the cursor tiebreaker arbitrary and silently
 * skip rows across a page boundary.
 */
describe('IdFactory', () => {
  let factory: IdFactory;

  beforeEach(() => {
    factory = new IdFactory();
  });

  const minters: Array<[keyof IdFactory, string]> = [
    ['merchantId', API_ID_PREFIXES.merchant],
    ['userId', API_ID_PREFIXES.user],
    ['apiKeyId', API_ID_PREFIXES.apiKey],
    ['bankAccountId', API_ID_PREFIXES.bankAccount],
    ['paymentIntentId', API_ID_PREFIXES.paymentIntent],
    ['chargeId', API_ID_PREFIXES.charge],
    ['refundId', API_ID_PREFIXES.refund],
    ['disputeId', API_ID_PREFIXES.dispute],
    ['webhookEventId', API_ID_PREFIXES.webhookEvent],
  ];

  describe.each(minters)('%s', (method, prefix) => {
    it(`mints an id with the ${prefix} prefix`, () => {
      const id = (factory[method] as () => string)();

      expect(id.startsWith(prefix)).toBe(true);
    });

    it('mints an id that validates', () => {
      const id = (factory[method] as () => string)();

      expect(isPayzenoId(id, prefix)).toBe(true);
    });

    it('mints a 26-character Crockford body', () => {
      const id = (factory[method] as () => string)();

      expect(id.slice(prefix.length)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('never repeats', () => {
      const ids = new Set(Array.from({ length: 500 }, () => (factory[method] as () => string)()));

      expect(ids.size).toBe(500);
    });
  });

  it('covers all nine payzeno-owned prefixes', () => {
    expect(minters).toHaveLength(Object.keys(API_ID_PREFIXES).length);
  });

  it('sorts lexicographically by creation order within a millisecond', () => {
    const at = Date.UTC(2026, 0, 15, 12, 0, 0);
    const ids = Array.from({ length: 50 }, () => factory.chargeId(at));

    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts across milliseconds too', () => {
    const first = factory.chargeId(Date.UTC(2026, 0, 15, 12, 0, 0));
    const later = factory.chargeId(Date.UTC(2026, 0, 15, 12, 0, 1));

    expect(later > first).toBe(true);
  });

  it('accepts an injected generator, so a spec can pin the body', () => {
    const pinned = new IdFactory(() => '01HQ8Z3K5N7P9R1T3V5W7Y9A0B');

    expect(pinned.chargeId()).toBe('ch_01HQ8Z3K5N7P9R1T3V5W7Y9A0B');
  });

  describe('opaque', () => {
    it('mints an id for a prefix outside the public table', () => {
      const id = factory.opaque('idem_');

      expect(id.startsWith('idem_')).toBe(true);
      expect(id.slice(5)).toHaveLength(26);
    });
  });

  describe('newId', () => {
    it('is usable without DI, for entity defaults and migrations', () => {
      const id = newId(API_ID_PREFIXES.charge);

      expect(isPayzenoId(id, API_ID_PREFIXES.charge)).toBe(true);
    });
  });
});

describe('id.prefix', () => {
  it('lists nine payzeno-owned prefixes', () => {
    expect(Object.keys(API_ID_PREFIXES)).toHaveLength(9);
  });

  it('includes the foreign prefixes payzeno-api stores but never mints', () => {
    expect(ALL_PREFIXES).toEqual(
      expect.arrayContaining([FOREIGN_ID_PREFIXES.payout, FOREIGN_ID_PREFIXES.settlementBatch]),
    );
  });

  it('uses `sk_`-free prefixes — a key prefix would collide with the bearer format', () => {
    expect(ALL_PREFIXES).not.toContain('sk_');
    expect(ALL_PREFIXES).not.toContain('pk_');
  });

  describe('isPayzenoId', () => {
    const valid = 'ch_01HQ8Z3K5N7P9R1T3V5W7Y9A0B';

    it('accepts a well-formed id', () => {
      expect(isPayzenoId(valid)).toBe(true);
    });

    it('accepts it against its own prefix', () => {
      expect(isPayzenoId(valid, 'ch_')).toBe(true);
    });

    it('rejects it against a different prefix', () => {
      expect(isPayzenoId(valid, 'pi_')).toBe(false);
    });

    it('rejects an unknown prefix', () => {
      expect(isPayzenoId('zz_01HQ8Z3K5N7P9R1T3V5W7Y9A0B')).toBe(false);
    });

    it('rejects a short body', () => {
      expect(isPayzenoId('ch_01HQ8Z3K5N')).toBe(false);
    });

    it('rejects the Crockford-excluded letters I, L, O and U', () => {
      expect(isPayzenoId('ch_01HQ8Z3K5N7P9R1T3V5W7Y9A0I')).toBe(false);
      expect(isPayzenoId('ch_01HQ8Z3K5N7P9R1T3V5W7Y9A0U')).toBe(false);
    });

    it('rejects a lower-case body', () => {
      expect(isPayzenoId('ch_01hq8z3k5n7p9r1t3v5w7y9a0b')).toBe(false);
    });

    it('rejects a non-string', () => {
      expect(isPayzenoId(null)).toBe(false);
      expect(isPayzenoId(42)).toBe(false);
      expect(isPayzenoId(undefined)).toBe(false);
    });
  });

  describe('prefixOf', () => {
    it('extracts a known prefix', () => {
      expect(prefixOf('ch_01HQ8Z3K5N7P9R1T3V5W7Y9A0B')).toBe('ch_');
      expect(prefixOf('po_01HQ8Z3K5N7P9R1T3V5W7Y9A0B')).toBe('po_');
    });

    it('returns null for an unknown prefix', () => {
      expect(prefixOf('zz_something')).toBeNull();
    });
  });
});
