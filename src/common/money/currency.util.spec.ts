import { CURRENCIES, CURRENCY_EXPONENT } from '@payzeno/contracts';

import { ValidationException } from 'src/common/errors/api.exception';
import {
  assertSupportedCurrency,
  exponentOf,
  isSupportedCurrency,
  minorPerMajor,
  normaliseCountry,
  normaliseCurrency,
} from 'src/common/money/currency.util';

/**
 * Currency helpers. The one behaviour that matters more than the others: JPY's exponent
 * is 0. Anything in this repo that hardcodes 100 is a bug, and this file is where that
 * assumption gets caught.
 */
describe('currency.util', () => {
  describe('isSupportedCurrency', () => {
    it.each([...CURRENCIES])('accepts %s', (currency) => {
      expect(isSupportedCurrency(currency)).toBe(true);
    });

    it('rejects a currency the platform does not settle', () => {
      expect(isSupportedCurrency('CHF')).toBe(false);
      expect(isSupportedCurrency('SEK')).toBe(false);
    });

    it('rejects a lower-case code — the contract vocabulary is upper-case', () => {
      expect(isSupportedCurrency('gbp')).toBe(false);
    });

    it('rejects a non-string', () => {
      expect(isSupportedCurrency(null)).toBe(false);
      expect(isSupportedCurrency(826)).toBe(false);
      expect(isSupportedCurrency(undefined)).toBe(false);
    });
  });

  describe('normaliseCurrency', () => {
    it('upper-cases a valid code', () => {
      expect(normaliseCurrency('gbp')).toBe('GBP');
      expect(normaliseCurrency('Eur')).toBe('EUR');
    });

    it('trims surrounding whitespace', () => {
      expect(normaliseCurrency('  usd  ')).toBe('USD');
    });

    it('throws for an unsupported code rather than returning a cast', () => {
      expect(() => normaliseCurrency('CHF')).toThrow();
    });
  });

  describe('normaliseCountry', () => {
    it('upper-cases and trims', () => {
      expect(normaliseCountry(' gb ')).toBe('GB');
    });

    it('leaves an already-normal code alone', () => {
      expect(normaliseCountry('DE')).toBe('DE');
    });
  });

  describe('exponentOf', () => {
    it.each([
      ['USD', 2],
      ['EUR', 2],
      ['GBP', 2],
      ['ILS', 2],
      ['JPY', 0],
    ] as const)('reports %s as exponent %d', (currency, expected) => {
      expect(exponentOf(currency)).toBe(expected);
    });

    it('agrees with the contracts table for every currency', () => {
      for (const currency of CURRENCIES) {
        expect(exponentOf(currency)).toBe(CURRENCY_EXPONENT[currency]);
      }
    });
  });

  describe('minorPerMajor', () => {
    it('is 100 for the two-decimal currencies', () => {
      expect(minorPerMajor('GBP')).toBe(100);
      expect(minorPerMajor('USD')).toBe(100);
    });

    it('is 1 for JPY', () => {
      // ¥5,000 is 5000 minor units, not 500000. Everything downstream of this — the
      // console's formatter, the ledger's posting amounts, the acquirer request — breaks
      // in a different way if this returns 100.
      expect(minorPerMajor('JPY')).toBe(1);
    });
  });

  describe('assertSupportedCurrency', () => {
    it('returns the normalised code for a supported currency', () => {
      expect(assertSupportedCurrency('gbp')).toBe('GBP');
    });

    it('throws a ValidationException — a 422, not a 500', () => {
      expect(() => assertSupportedCurrency('CHF')).toThrow(ValidationException);
    });

    it('reports the field path it was given', () => {
      try {
        assertSupportedCurrency('CHF', 'lines.0.currency');
        throw new Error('expected a ValidationException');
      } catch (err) {
        const fieldErrors = (err as ValidationException).fieldErrors ?? [];
        expect(fieldErrors[0]?.path).toBe('lines.0.currency');
      }
    });

    it('defaults the path to `currency`', () => {
      try {
        assertSupportedCurrency('CHF');
        throw new Error('expected a ValidationException');
      } catch (err) {
        const fieldErrors = (err as ValidationException).fieldErrors ?? [];
        expect(fieldErrors[0]?.path).toBe('currency');
      }
    });
  });
});
