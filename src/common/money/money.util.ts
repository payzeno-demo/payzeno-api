/**
 * Money — a thin re-export of @payzeno/contracts/money plus the two helpers that only make
 * sense inside an HTTP service.
 *
 * There is no second money implementation in this repo and there will not be one. If you need
 * arithmetic that is not here, add it to the contracts package so payzeno-ledger and
 * payzeno-console get the same behaviour. domain-model.md §0.1.
 */
import {
  addMoney,
  applyBps,
  assertSameCurrency,
  formatMoney,
  fromMinor,
  isZero,
  subMoney,
  toMinor,
} from '@payzeno/contracts/money';
import { CURRENCY_EXPONENT, type CurrencyCode, type MinorUnits, type Money } from '@payzeno/contracts';

export {
  addMoney,
  applyBps,
  assertSameCurrency,
  formatMoney,
  fromMinor,
  isZero,
  subMoney,
  toMinor,
};

export function money(amountMinor: MinorUnits, currency: CurrencyCode): Money {
  return { amount_minor: amountMinor, currency };
}

/**
 * Smallest chargeable amount per currency. JPY's exponent is 0, so its minimum is 50 yen, not
 * 50 sen — anything that hardcodes 100 here is the bug domain-model.md §0.1 warns about.
 */
export function minimumChargeableMinor(currency: CurrencyCode): MinorUnits {
  return CURRENCY_EXPONENT[currency] === 0 ? 50 : 50;
}

/** Scheme ceiling per authorisation. Above this the acquirer rejects before the issuer sees it. */
export function maximumChargeableMinor(currency: CurrencyCode): MinorUnits {
  return CURRENCY_EXPONENT[currency] === 0 ? 100_000_000 : 99_999_999;
}

/** Sums same-currency amounts; throws CurrencyMismatchError on the first mismatch. */
export function sumMoney(values: readonly Money[]): Money | null {
  if (values.length === 0) return null;
  return values.reduce((acc, next) => addMoney(acc, next));
}
