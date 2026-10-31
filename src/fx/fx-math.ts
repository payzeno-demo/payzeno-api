/**
 * FX arithmetic. L0, pure: decimal strings in, decimal strings or integer minor units out.
 *
 * Rates are decimals as strings ("0.9231"), exactly like money — a float rate is a rounding
 * error waiting for a large enough amount. Everything here is BigInt fixed-point with
 * ROUND_HALF_UP, the rounding `@payzeno/contracts` money uses, and minor units are converted
 * through each currency's own exponent (JPY has none), never through a literal 100.
 */
import { CURRENCY_EXPONENT, type CurrencyCode } from '@payzeno/contracts';

/** Digits kept on a computed rate. Provider rates have four to six; ten is comfortably more. */
export const RATE_SCALE = 10;

interface Fixed {
  units: bigint;
  scale: number;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function parse(value: string): Fixed {
  const match = DECIMAL.exec(value.trim());
  if (!match) {
    throw new RangeError(`not a non-negative decimal: ${value}`);
  }
  const fraction = match[2] ?? '';
  return { units: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

/** n / d, both positive, rounded half up. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (d * 2n);
}

/** Fixed-point → "123.4567", trailing zeros trimmed, never a bare trailing dot. */
function format(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** True for a strictly positive decimal string. */
export function isPositiveDecimal(value: string): boolean {
  if (!DECIMAL.test(value.trim())) return false;
  return parse(value).units > 0n;
}

/**
 * The rate to one `from` in `to`, given both against the same base: `toPerBase / fromPerBase`.
 * The provider quotes everything per one USD; EUR→JPY is JPY-per-USD over EUR-per-USD.
 */
export function crossRate(fromPerBase: string, toPerBase: string): string {
  const from = parse(fromPerBase);
  const to = parse(toPerBase);
  if (from.units === 0n) throw new RangeError('a zero rate has no inverse');
  // (to.units / 10^to.scale) / (from.units / 10^from.scale), at RATE_SCALE digits.
  const numerator = to.units * pow10(from.scale + RATE_SCALE);
  const denominator = from.units * pow10(to.scale);
  return format(divRoundHalfUp(numerator, denominator), RATE_SCALE);
}

/** mid × (1 + bps / 10 000), at RATE_SCALE digits. */
export function applyMarkup(midRate: string, markupBps: number): string {
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 10_000) {
    throw new RangeError(`markup must be 0..10000 bps, got ${markupBps}`);
  }
  const mid = parse(midRate);
  const numerator = mid.units * BigInt(10_000 + markupBps) * pow10(RATE_SCALE);
  const denominator = 10_000n * pow10(mid.scale);
  return format(divRoundHalfUp(numerator, denominator), RATE_SCALE);
}

/**
 * `amountMinor` of `from` in `to` at `rate` (to per one from), rounded half up to `to`'s minor
 * unit. 10.00 USD at 0.94156 EUR is 9.42 EUR (942); 10.00 USD at 152.1 JPY is ¥1521.
 */
export function convertMinor(amountMinor: number, from: CurrencyCode, to: CurrencyCode, rate: string): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`amount must be a non-negative integer, got ${amountMinor}`);
  }
  const r = parse(rate);
  const fromExp = CURRENCY_EXPONENT[from];
  const toExp = CURRENCY_EXPONENT[to];
  // amount / 10^fromExp × rate × 10^toExp
  const numerator = BigInt(amountMinor) * r.units * pow10(toExp);
  const denominator = pow10(r.scale + fromExp);
  return Number(divRoundHalfUp(numerator, denominator));
}
