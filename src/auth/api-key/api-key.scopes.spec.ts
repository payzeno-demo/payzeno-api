import { API_KEY_SCOPES } from '@payzeno/contracts';

import {
  ALL_SCOPES,
  DEFAULT_SCOPES,
  IMPLIED_SCOPES,
  READ_SCOPES,
  UnknownScopeError,
  WRITE_SCOPES,
  coversRequired,
  expandScopes,
  firstMissingScope,
  isApiKeyScope,
  parseScopes,
} from 'src/auth/api-key/api-key.scopes';

/**
 * The scope vocabulary. PAY-2071 — my first change outside a migration, and the spec osquash
 * asked for in round two of review. (He was right: I had the implication table derived from
 * `scope.replace(':write', ':read')`, which silently invents `balance:write`.)
 *
 * The three things worth pinning down, in the order they bit me:
 *
 *   1. the default grant is read-only. Migration 19 gives the column a `'{}'` default, which
 *      would authorise nothing at all, so a key created without an explicit list has to get
 *      its scopes from here.
 *   2. write implies read, but only where the read actually exists.
 *   3. `parseScopes` rejects unknown strings at the DTO boundary, so the column stays a
 *      vocabulary rather than a free-text array.
 *
 * — ystackoverflow
 */
describe('api-key scopes', () => {
  describe('the vocabulary', () => {
    it('is exactly the contract list — this repo does not add scopes', () => {
      expect(ALL_SCOPES).toEqual(API_KEY_SCOPES);
    });

    it('partitions into reads and writes with nothing left over', () => {
      expect(READ_SCOPES.length + WRITE_SCOPES.length).toBe(ALL_SCOPES.length);
    });

    it('has more reads than writes — several resources are read-only', () => {
      // balance, settlements, invoices and charges have no write scope at all.
      expect(READ_SCOPES.length).toBeGreaterThan(WRITE_SCOPES.length);
    });

    it('recognises a real scope', () => {
      expect(isApiKeyScope('payment_intents:write')).toBe(true);
    });

    it('rejects a plausible-looking scope that does not exist', () => {
      expect(isApiKeyScope('balance:write')).toBe(false);
      expect(isApiKeyScope('payments:write')).toBe(false);
    });
  });

  describe('DEFAULT_SCOPES', () => {
    it('is every read scope', () => {
      expect(DEFAULT_SCOPES).toEqual(READ_SCOPES);
    });

    it('grants no write scope — a merchant who wants to move money has to say so', () => {
      for (const scope of DEFAULT_SCOPES) {
        expect(scope.endsWith(':write')).toBe(false);
      }
    });
  });

  describe('IMPLIED_SCOPES', () => {
    it('only maps scopes that exist', () => {
      for (const [scope, implied] of Object.entries(IMPLIED_SCOPES)) {
        expect(isApiKeyScope(scope)).toBe(true);
        for (const target of implied ?? []) {
          expect(isApiKeyScope(target)).toBe(true);
        }
      }
    });

    it('gives payment_intents:write the charge read as well', () => {
      // A key that can create an intent and cannot read the resulting charge is useless,
      // and every merchant integrating hit this in the first hour.
      expect(IMPLIED_SCOPES['payment_intents:write']).toContain('charges:read');
    });

    it('does not pretend balance or settlements have a write counterpart', () => {
      expect(IMPLIED_SCOPES['balance:read' as keyof typeof IMPLIED_SCOPES]).toBeUndefined();
      expect(IMPLIED_SCOPES['settlements:read' as keyof typeof IMPLIED_SCOPES]).toBeUndefined();
    });
  });

  describe('expandScopes', () => {
    it('adds the implied reads', () => {
      expect(expandScopes(['refunds:write']).sort()).toEqual(['refunds:read', 'refunds:write']);
    });

    it('deduplicates when the read was granted explicitly too', () => {
      expect(expandScopes(['refunds:write', 'refunds:read'])).toHaveLength(2);
    });

    it('leaves a read-only grant untouched', () => {
      expect(expandScopes(['balance:read'])).toEqual(['balance:read']);
    });

    it('returns an empty array for an empty grant', () => {
      expect(expandScopes([])).toEqual([]);
    });

    it('expands payouts:write into both of its reads', () => {
      expect(expandScopes(['payouts:write']).sort()).toEqual([
        'balance:read',
        'payouts:read',
        'payouts:write',
      ]);
    });
  });

  describe('parseScopes', () => {
    it('passes known scopes through unchanged', () => {
      expect(parseScopes(['refunds:read', 'refunds:write'])).toEqual(['refunds:read', 'refunds:write']);
    });

    it('throws UnknownScopeError naming every bad value, not just the first', () => {
      // The DTO turns this into a 422 listing them all — three round-trips to find three
      // typos is three round-trips too many.
      expect(() => parseScopes(['refunds:read', 'balance:write', 'nope'])).toThrow(UnknownScopeError);

      try {
        parseScopes(['refunds:read', 'balance:write', 'nope']);
      } catch (err) {
        expect((err as UnknownScopeError).unknownScopes).toEqual(['balance:write', 'nope']);
      }
    });

    it('accepts the empty list', () => {
      expect(parseScopes([])).toEqual([]);
    });
  });

  describe('coversRequired', () => {
    it('is true when the grant matches exactly', () => {
      expect(coversRequired(['refunds:read'], ['refunds:read'])).toBe(true);
    });

    it('is true through an implication', () => {
      expect(coversRequired(['refunds:write'], ['refunds:read'])).toBe(true);
    });

    it('is false when one of several required scopes is missing', () => {
      expect(coversRequired(['refunds:write'], ['refunds:read', 'disputes:read'])).toBe(false);
    });

    it('is true when nothing is required — an unannotated handler is not scope-gated', () => {
      expect(coversRequired([], [])).toBe(true);
    });

    it('is false when something is required and nothing was granted', () => {
      expect(coversRequired([], ['merchants:read'])).toBe(false);
    });

    it('does not let a read imply a write', () => {
      expect(coversRequired(['payouts:read'], ['payouts:write'])).toBe(false);
    });
  });

  describe('firstMissingScope', () => {
    it('names the missing scope, in the order the handler asked for them', () => {
      expect(firstMissingScope(['refunds:read'], ['refunds:read', 'disputes:write'])).toBe(
        'disputes:write',
      );
    });

    it('is null when everything is covered', () => {
      expect(firstMissingScope(['payouts:write'], ['balance:read'])).toBeNull();
    });
  });
});
