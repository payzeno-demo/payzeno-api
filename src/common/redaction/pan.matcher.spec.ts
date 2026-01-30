import {
  REDACTED_PAN,
  containsPan,
  looksLikePan,
  luhnValid,
  maskPans,
} from 'src/common/redaction/pan.matcher';

/**
 * arc PCI. The matcher is 13-19 digits, Luhn-valid, with space and dash tolerance —
 * because the leak that started the arc was a PAN typed into a `description` field with
 * spaces in it, which a `\d{16}` regex walked straight past.
 *
 * The negative cases matter as much as the positives: a 9-digit ABA routing number is
 * not Luhn-valid and not in the band, which is exactly why the bank-account leak needed
 * a separate fix and could not ride on this one.
 */
describe('pan.matcher', () => {
  describe('luhnValid', () => {
    it.each([
      '4242424242424242',
      '5555555555554444',
      '378282246310005',
      '6011111111111117',
      '4000056655665556',
    ])('accepts the test PAN %s', (pan) => {
      expect(luhnValid(pan)).toBe(true);
    });

    it('rejects a number one digit off', () => {
      expect(luhnValid('4242424242424243')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(luhnValid('')).toBe(false);
    });

    it('rejects non-digits', () => {
      expect(luhnValid('42424242424242xx')).toBe(false);
    });
  });

  describe('looksLikePan', () => {
    it('accepts a 16-digit Luhn-valid number', () => {
      expect(looksLikePan('4242424242424242')).toBe(true);
    });

    it('accepts a 15-digit Amex', () => {
      expect(looksLikePan('378282246310005')).toBe(true);
    });

    it('rejects a 12-digit number — below the band', () => {
      expect(looksLikePan('424242424242')).toBe(false);
    });

    it('rejects a 20-digit number — above the band', () => {
      expect(looksLikePan('42424242424242424242')).toBe(false);
    });

    it('rejects a 9-digit ABA routing number', () => {
      // The reason CreateBankAccountRequest needed its own tokenisation fix rather than
      // riding on this matcher.
      expect(looksLikePan('021000021')).toBe(false);
    });

    it('rejects an in-band number that fails Luhn', () => {
      expect(looksLikePan('1234567812345678')).toBe(false);
    });
  });

  describe('containsPan', () => {
    it('finds a bare PAN in free text', () => {
      expect(containsPan('the card is 4242424242424242 thanks')).toBe(true);
    });

    it('finds a space-separated PAN', () => {
      expect(containsPan('4242 4242 4242 4242')).toBe(true);
    });

    it('finds a dash-separated PAN', () => {
      expect(containsPan('4242-4242-4242-4242')).toBe(true);
    });

    it('finds a mixed-separator PAN', () => {
      expect(containsPan('4242 4242-4242 4242')).toBe(true);
    });

    it('does not fire on an order number', () => {
      expect(containsPan('order 4471 for customer 8812')).toBe(false);
    });

    it('does not fire on a merchant id', () => {
      expect(containsPan('mch_01HQ8Z3K5N7P9R1T3V5W7Y9A0B')).toBe(false);
    });

    it('does not fire on an ISO timestamp', () => {
      expect(containsPan('2026-01-15T12:00:00.000Z')).toBe(false);
    });

    it('does not fire on a last-four', () => {
      expect(containsPan('card ending 4242')).toBe(false);
    });
  });

  describe('maskPans', () => {
    it('replaces a PAN with the redaction marker', () => {
      expect(maskPans('pay with 4242424242424242')).toBe(`pay with ${REDACTED_PAN}`);
    });

    it('replaces a separated PAN', () => {
      expect(maskPans('card: 4242 4242 4242 4242.')).toBe(`card: ${REDACTED_PAN}.`);
    });

    it('replaces every PAN in a string', () => {
      const masked = maskPans('4242424242424242 and 5555555555554444');

      expect(masked).toBe(`${REDACTED_PAN} and ${REDACTED_PAN}`);
      expect(masked).not.toMatch(/\d{13,}/);
    });

    it('leaves text with no PAN untouched', () => {
      const text = 'Order 4471, £45.00, customer 8812';

      expect(maskPans(text)).toBe(text);
    });

    it('is idempotent', () => {
      const once = maskPans('4242424242424242');

      expect(maskPans(once)).toBe(once);
    });
  });
});
