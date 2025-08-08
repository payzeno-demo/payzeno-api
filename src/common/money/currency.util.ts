/**
 * Currency helpers. Two of these exist because `char(3)` blank-pads in Postgres and compares
 * with trailing spaces in some drivers (domain-model.md §0.1.1) — every read path trims, and
 * every comparison is against a trimmed literal.
 */
import { CURRENCIES, CURRENCY_EXPONENT, type CurrencyCode } from '@payzeno/contracts';

import { ValidationException } from '../errors/api.exception';

export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value.trim().toUpperCase());
}

/** Trims and upper-cases a `char(3)` read out of Postgres. */
export function normaliseCurrency(value: string): CurrencyCode {
  const trimmed = value.trim().toUpperCase();
  if (!isSupportedCurrency(trimmed)) {
    throw new ValidationException(`Unsupported currency '${value.trim()}'`, [
      { path: 'currency', code: 'unsupported_currency', message: `Unsupported currency '${value.trim()}'` },
    ]);
  }
  return trimmed;
}

/** Same trim for `char(2)` country columns. */
export function normaliseCountry(value: string): string {
  return value.trim().toUpperCase();
}

export function exponentOf(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency];
}

/** Minor units in one major unit. 100 for USD/EUR/GBP/ILS, 1 for JPY. */
export function minorPerMajor(currency: CurrencyCode): number {
  return 10 ** CURRENCY_EXPONENT[currency];
}

export function assertSupportedCurrency(value: string, path = 'currency'): CurrencyCode {
  if (!isSupportedCurrency(value)) {
    throw new ValidationException(`Unsupported currency '${value}'`, [
      { path, code: 'unsupported_currency', message: `Payzeno supports ${CURRENCIES.join(', ')}` },
    ]);
  }
  return value.trim().toUpperCase() as CurrencyCode;
}
