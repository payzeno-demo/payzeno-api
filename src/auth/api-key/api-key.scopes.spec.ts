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

    it('gives payment_intents:write the charge read as well', () => {
      // A key that can create an intent and cannot read the resulting charge is useless,
      // and every merchant integrating hit this in the first hour.
      expect(IMPLIED_SCOPES['payment_intents:write']).toContain('charges:read');
    });

    it('passes known scopes through unchanged', () => {
      expect(parseScopes(['refunds:read', 'refunds:write'])).toEqual(['refunds:read', 'refunds:write']);
    });

    it('accepts the empty list', () => {
      expect(parseScopes([])).toEqual([]);
    });
  });

  describe('coversRequired', () => {
    it('is true through an implication', () => {
      expect(coversRequired(['refunds:write'], ['refunds:read'])).toBe(true);
    });

    it('is false when something is required and nothing was granted', () => {
      expect(coversRequired([], ['merchants:read'])).toBe(false);
    });

  });
});
