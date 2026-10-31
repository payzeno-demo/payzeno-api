/**
 * Payzeno's platform risk rules. RFC platform-v2 §8. L5: pure, no I/O, no clock.
 *
 * Evaluated at confirm, after the acquirer has authorised (so its score is known) and before
 * capture. Every rule that fires is reported; the outcome is the most severe:
 *
 *   block   any block-level rule, or two review-level rules at once
 *   review  any review-level rule      → auth kept uncaptured, a `Review` opened
 *   allow   nothing fired
 *
 * The thresholds are config, not UI (RFC), and they are tuned so the demo's normal traffic —
 * small baskets, shoppers mostly in the merchant's own country — is `allow`. What trips them,
 * with the sandbox cards from sim-world/README.md:
 *
 *   review  a GB card (4000 0082 6000 0422) from a JP shopper (`?country=JP`) for 300.00 USD
 *           → `country_mismatch`
 *   block   the same card and shopper for 1,200.00 USD at a merchant younger than 30 days
 *           → `country_mismatch` + `new_merchant_large_amount`
 *   block   a card that failed six times in the last hour, or ten different cards from one
 *           address in an hour
 *
 * The acquirer-score rules exist for production acquirers: the sandbox scores approvals 1–35,
 * so they never fire locally.
 */
import type { CurrencyCode, RiskOutcome, RiskRule } from '@payzeno/contracts';

export const RISK_THRESHOLDS = {
  acquirerScoreReview: 75,
  acquirerScoreBlock: 90,
  /** Attempts with one card fingerprint in the last hour, any merchant, before this one. */
  cardAttemptsReview: 30,
  /** Failed (declined or blocked) attempts with one card in the last hour. */
  cardFailuresReview: 3,
  cardFailuresBlock: 6,
  /** Distinct cards from one shopper address in the last hour, this one included. */
  ipDistinctCardsReview: 5,
  ipDistinctCardsBlock: 10,
  /** `amount_spike`: this many times the merchant's 30-day average… */
  amountSpikeMultiple: 10,
  /** …over at least this many captured payments in that currency. */
  amountSpikeMinSample: 20,
  /** `new_merchant_large_amount`: merchants younger than this… */
  newMerchantDays: 30,
  /** Review-level rules that, together, are a block. */
  reviewRulesToBlock: 2,
} as const;

/**
 * Roughly 250 USD in each supported currency. A foreign card from a foreign country below this
 * is a tourist buying coffee; above it is worth a second look.
 */
export const HIGH_VALUE_MINOR: Readonly<Record<CurrencyCode, number>> = {
  USD: 25_000,
  EUR: 25_000,
  GBP: 20_000,
  ILS: 90_000,
  JPY: 35_000,
};

/** Roughly 1,000 USD: what a merchant still in its first month should not be taking unseen. */
export const LARGE_VALUE_MINOR: Readonly<Record<CurrencyCode, number>> = {
  USD: 100_000,
  EUR: 100_000,
  GBP: 80_000,
  ILS: 360_000,
  JPY: 140_000,
};

export interface RiskSignals {
  acquirerScore: number;
  amountMinor: number;
  currency: CurrencyCode;
  /** Shopper's country from the edge; null when unknown (server-to-server confirms). */
  ipCountry: string | null;
  cardCountry: string | null;
  cardAttemptsLastHour: number;
  cardFailuresLastHour: number;
  /** Null when the shopper's address is unknown. */
  ipDistinctCardsLastHour: number | null;
  /** Null when there is no history in this currency. */
  merchantAverageMinor: number | null;
  merchantSampleSize: number;
  merchantAgeDays: number;
}

export interface RiskDecision {
  outcome: RiskOutcome;
  rules: RiskRule[];
}

type Severity = 'review' | 'block';

export function evaluateRisk(signals: RiskSignals): RiskDecision {
  const fired: Array<[RiskRule, Severity]> = [];
  const t = RISK_THRESHOLDS;
  const highValue = signals.amountMinor >= HIGH_VALUE_MINOR[signals.currency];

  if (signals.acquirerScore >= t.acquirerScoreBlock) {
    fired.push(['very_high_acquirer_score', 'block']);
  } else if (signals.acquirerScore >= t.acquirerScoreReview) {
    fired.push(['high_acquirer_score', 'review']);
  }

  if (signals.ipCountry && signals.cardCountry && signals.ipCountry !== signals.cardCountry && highValue) {
    fired.push(['country_mismatch', 'review']);
  }

  if (signals.cardFailuresLastHour >= t.cardFailuresBlock) {
    fired.push(['card_velocity', 'block']);
  } else if (
    signals.cardFailuresLastHour >= t.cardFailuresReview ||
    signals.cardAttemptsLastHour >= t.cardAttemptsReview
  ) {
    fired.push(['card_velocity', 'review']);
  }

  if (signals.ipDistinctCardsLastHour !== null) {
    if (signals.ipDistinctCardsLastHour >= t.ipDistinctCardsBlock) {
      fired.push(['ip_velocity', 'block']);
    } else if (signals.ipDistinctCardsLastHour >= t.ipDistinctCardsReview) {
      fired.push(['ip_velocity', 'review']);
    }
  }

  if (
    highValue &&
    signals.merchantAverageMinor !== null &&
    signals.merchantSampleSize >= t.amountSpikeMinSample &&
    signals.amountMinor >= signals.merchantAverageMinor * t.amountSpikeMultiple
  ) {
    fired.push(['amount_spike', 'review']);
  }

  if (signals.merchantAgeDays < t.newMerchantDays && signals.amountMinor >= LARGE_VALUE_MINOR[signals.currency]) {
    fired.push(['new_merchant_large_amount', 'review']);
  }

  const rules = fired.map(([rule]) => rule);
  const reviews = fired.filter(([, severity]) => severity === 'review').length;
  const blocked = fired.some(([, severity]) => severity === 'block') || reviews >= t.reviewRulesToBlock;

  return { outcome: blocked ? 'block' : reviews > 0 ? 'review' : 'allow', rules };
}
