/**
 * PAN detection — 13-19 digit Luhn-valid runs, tolerating space and dash separators.
 *
 * `4111 1111 1111 1111` and `4111-1111-1111-1111` are both PANs and both used to survive a
 * naive `\d{13,19}` regex. The Luhn check is what keeps this from redacting every order id
 * and every ULID-adjacent numeric string in the corpus — without it the false-positive rate
 * made engineers turn the flag off, which is a worse outcome than a slower regex.
 *
 * arc PCI. docs/compliance/pci-scope.md cites this file by path.
 */

export const REDACTED_PAN = '[REDACTED_PAN]';

/** Digit runs of 13-19 with optional single space/dash separators between digits. */
const CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;

    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/** True when the string, stripped of separators, is a Luhn-valid 13-19 digit number. */
export function looksLikePan(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  return /^\d+$/.test(digits) && luhnValid(digits);
}

/** Does this arbitrary text contain a PAN anywhere? Used by MetadataValidator. */
export function containsPan(text: string): boolean {
  CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    if (looksLikePan(match[0])) return true;
  }
  return false;
}

/** Replaces every PAN-shaped run with `[REDACTED_PAN]`, leaving everything else intact. */
export function maskPans(text: string): string {
  return text.replace(CANDIDATE, (match) => (looksLikePan(match) ? REDACTED_PAN : match));
}
