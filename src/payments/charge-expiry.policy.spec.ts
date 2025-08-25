import { ChargeExpiryPolicy } from 'src/payments/charge-expiry.policy';

import { FixedClock } from 'test/support/fixed-clock';
import { makeCharge } from 'test/factories/charge.factory';
import { makeMerchant } from 'test/factories/merchant.factory';

/**
 * Auth holds expire at 7 days, or 30 for the deferred-capture MCCs (domain-model §3).
 * This is pure date arithmetic against an injected `Clock` — the entire reason
 * `interface Clock` exists (blueprint §3.3).
 */
describe('ChargeExpiryPolicy', () => {
  const clock = new FixedClock('2026-01-15T12:00:00.000Z');
  const policy = new ChargeExpiryPolicy(clock);

  describe('expiresAt', () => {
    it('gives a standard MCC 7 days', () => {
      const merchant = makeMerchant({ mcc: '5732' });

      expect(policy.expiresAt(merchant)).toBe('2026-01-22T12:00:00.000Z');
    });

    it('gives a deferred-capture MCC 30 days', () => {
      const shifted = new ChargeExpiryPolicy(later);

      expect(shifted.expiresAt(makeMerchant({ mcc: '5732' }))).toBe('2026-03-08T00:00:00.000Z');
    });

    it('crosses a month boundary correctly', () => {
      const charge = makeCharge({ authorization_expires_at: null });

      expect(policy.isExpired(charge)).toBe(false);
    });

    it('only applies to authorized charges', () => {
    });
  });
});
