import { applyMarkup, convertMinor, crossRate, isPositiveDecimal } from 'src/fx/fx-math';

describe('fx-math', () => {
  describe('crossRate', () => {
    it('is the target per base over the source per base', () => {
      // EUR→JPY with 0.9231 EUR and 152.10 JPY per USD.
      expect(crossRate('0.9231', '152.10')).toBe('164.770880728');
    });

    it('inverts against the base itself', () => {
      expect(crossRate('0.8', '1')).toBe('1.25');
      expect(crossRate('1', '0.9231')).toBe('0.9231');
    });

    it('refuses a zero source rate', () => {
      expect(() => crossRate('0', '1')).toThrow(RangeError);
    });
  });

  describe('applyMarkup', () => {
    it('adds the markup in basis points', () => {
      expect(applyMarkup('0.9231', 200)).toBe('0.941562');
      expect(applyMarkup('152.1', 200)).toBe('155.142');
    });

    it('is the mid rate at zero markup', () => {
      expect(applyMarkup('1.0842', 0)).toBe('1.0842');
    });

    it('refuses a markup outside 0..10000', () => {
      expect(() => applyMarkup('1', -1)).toThrow(RangeError);
      expect(() => applyMarkup('1', 1.5)).toThrow(RangeError);
    });
  });

  describe('convertMinor', () => {
    it('rounds half up to the target minor unit', () => {
      expect(convertMinor(1000, 'USD', 'EUR', '0.941562')).toBe(942);
      expect(convertMinor(3800, 'USD', 'EUR', '0.941562')).toBe(3578);
    });

    it('converts into a currency without minor units', () => {
      expect(convertMinor(1000, 'USD', 'JPY', '155.142')).toBe(1551);
    });

    it('converts out of a currency without minor units', () => {
      // ¥3000 at 0.0064 USD per JPY is $19.20.
      expect(convertMinor(3000, 'JPY', 'USD', '0.0064')).toBe(1920);
    });

    it('rounds exactly half up', () => {
      // 1.005 → 1.01: 100 minor × 1.005 = 100.5 → 101.
      expect(convertMinor(100, 'USD', 'EUR', '1.005')).toBe(101);
    });

    it('refuses a fractional or negative amount', () => {
      expect(() => convertMinor(1.5, 'USD', 'EUR', '1')).toThrow(RangeError);
      expect(() => convertMinor(-1, 'USD', 'EUR', '1')).toThrow(RangeError);
    });
  });

  it('recognises positive decimals only', () => {
    expect(isPositiveDecimal('0.9231')).toBe(true);
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('-1')).toBe(false);
    expect(isPositiveDecimal('1e3')).toBe(false);
  });
});
