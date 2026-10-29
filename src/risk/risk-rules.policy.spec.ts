import { evaluateRisk, type RiskSignals } from 'src/risk/risk-rules.policy';

/**
 * A coffee bought at home from an established merchant: nothing should fire. No spend history,
 * so `amount_spike` stays out of the tests that are about other rules; the spike tests add it.
 */
function signals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    acquirerScore: 12,
    amountMinor: 3_800,
    currency: 'USD',
    ipCountry: 'US',
    cardCountry: 'US',
    cardAttemptsLastHour: 1,
    cardFailuresLastHour: 0,
    ipDistinctCardsLastHour: 1,
    merchantAverageMinor: null,
    merchantSampleSize: 0,
    merchantAgeDays: 400,
    ...overrides,
  };
}

describe('evaluateRisk', () => {
  it('allows ordinary traffic', () => {
    expect(evaluateRisk(signals())).toEqual({ outcome: 'allow', rules: [] });
  });

  it('allows a small purchase on a foreign card — a tourist buying coffee', () => {
    expect(evaluateRisk(signals({ ipCountry: 'JP', cardCountry: 'GB' })).outcome).toBe('allow');
  });

  it('reviews a high-value purchase on a card from another country than the shopper', () => {
    expect(evaluateRisk(signals({ ipCountry: 'JP', cardCountry: 'GB', amountMinor: 30_000 }))).toEqual({
      outcome: 'review',
      rules: ['country_mismatch'],
    });
  });

  it('applies the high-value threshold in the payment currency', () => {
    expect(
      evaluateRisk(signals({ currency: 'JPY', ipCountry: 'US', cardCountry: 'GB', amountMinor: 30_000 })).outcome,
    ).toBe('allow');
    expect(
      evaluateRisk(signals({ currency: 'JPY', ipCountry: 'US', cardCountry: 'GB', amountMinor: 40_000 })).outcome,
    ).toBe('review');
  });

  it('cannot see a mismatch when either country is unknown', () => {
    expect(evaluateRisk(signals({ ipCountry: null, cardCountry: 'GB', amountMinor: 30_000 })).outcome).toBe('allow');
    expect(evaluateRisk(signals({ ipCountry: 'JP', cardCountry: null, amountMinor: 30_000 })).outcome).toBe('allow');
  });

  it('blocks two review-level rules together', () => {
    const decision = evaluateRisk(
      signals({ ipCountry: 'JP', cardCountry: 'GB', amountMinor: 120_000, merchantAgeDays: 3 }),
    );
    expect(decision).toEqual({ outcome: 'block', rules: ['country_mismatch', 'new_merchant_large_amount'] });
  });

  it('reviews a large amount at a new merchant on its own', () => {
    expect(evaluateRisk(signals({ amountMinor: 100_000, merchantAgeDays: 29 }))).toEqual({
      outcome: 'review',
      rules: ['new_merchant_large_amount'],
    });
    expect(evaluateRisk(signals({ amountMinor: 100_000, merchantAgeDays: 30 })).outcome).toBe('allow');
  });

  it('scores the acquirer: review from 75, block from 90', () => {
    expect(evaluateRisk(signals({ acquirerScore: 74 })).outcome).toBe('allow');
    expect(evaluateRisk(signals({ acquirerScore: 75 }))).toEqual({ outcome: 'review', rules: ['high_acquirer_score'] });
    expect(evaluateRisk(signals({ acquirerScore: 90 }))).toEqual({ outcome: 'block', rules: ['very_high_acquirer_score'] });
  });

  it('reviews a card that failed three times this hour, blocks one that failed six', () => {
    expect(evaluateRisk(signals({ cardFailuresLastHour: 3 })).outcome).toBe('review');
    expect(evaluateRisk(signals({ cardFailuresLastHour: 6 })).outcome).toBe('block');
  });

  it('reviews a card used thirty times this hour', () => {
    expect(evaluateRisk(signals({ cardAttemptsLastHour: 30 }))).toEqual({ outcome: 'review', rules: ['card_velocity'] });
  });

  it('reviews five distinct cards from one address, blocks ten', () => {
    expect(evaluateRisk(signals({ ipDistinctCardsLastHour: 5 })).outcome).toBe('review');
    expect(evaluateRisk(signals({ ipDistinctCardsLastHour: 10 })).outcome).toBe('block');
    expect(evaluateRisk(signals({ ipDistinctCardsLastHour: null })).outcome).toBe('allow');
  });

  it('reviews a high-value spike against an established average', () => {
    expect(evaluateRisk(signals({ amountMinor: 40_000, merchantAverageMinor: 3_000, merchantSampleSize: 200 }))).toEqual({
      outcome: 'review',
      rules: ['amount_spike'],
    });
  });

  it('does not call a spike without enough history', () => {
    expect(
      evaluateRisk(signals({ amountMinor: 40_000, merchantAverageMinor: 3_000, merchantSampleSize: 19 })).outcome,
    ).toBe('allow');
  });
});
