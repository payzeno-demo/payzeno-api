import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  canonicalJson,
  fingerprint,
  isValidIdempotencyKey,
} from 'src/common/idempotency/idempotency.types';

/**
 * The fingerprint is the whole of `409 idempotency_key_reuse`, so its edges matter more than
 * anything else in `src/common/idempotency/`.
 *
 * Two rules, and both have a failure mode with money attached:
 *
 *   - key order must not change the hash. `{amount, currency}` and `{currency, amount}` are
 *     the same request, and a client that serialises from a Map on retry would otherwise be
 *     told its own retry is a key reuse and would never learn the charge succeeded.
 *   - method and path ARE in the hash. Without them, a framework that attaches one key to a
 *     whole request chain gets undefined behaviour across two endpoints — and the endpoint
 *     that wins is whichever landed first.
 *
 * domain-model.md §0.3(a). docs/adr/0004-idempotency-storage.md.
 */
describe('idempotency fingerprint', () => {
  const BODY = { amount: 4_599, currency: 'GBP', metadata: { order: 'A-1' } };

  it('ignores key order at depth', () => {
    expect(
      fingerprint('POST', '/v1/payment_intents', { metadata: { a: 1, b: 2 } }),
    ).toBe(fingerprint('POST', '/v1/payment_intents', { metadata: { b: 2, a: 1 } }));
  });

  it('changes when a value changes', () => {
    expect(fingerprint('POST', '/v1/payment_intents', { amount: 4_599 })).not.toBe(
      fingerprint('POST', '/v1/payment_intents', { amount: 4_600 }),
    );
  });

  it('changes when the path changes', () => {
    expect(fingerprint('POST', '/v1/payment_intents', BODY)).not.toBe(
      fingerprint('POST', '/v1/refunds', BODY),
    );
  });

  it('changes when the method changes', () => {
    expect(fingerprint('POST', '/v1/payment_intents/pi_1', BODY)).not.toBe(
      fingerprint('PATCH', '/v1/payment_intents/pi_1', BODY),
    );
  });

  it('treats an undefined field as absent, matching what JSON.stringify sent on the wire', () => {
    expect(fingerprint('POST', '/v1/refunds', { amount: 1, note: undefined })).toBe(
      fingerprint('POST', '/v1/refunds', { amount: 1 }),
    );
  });

  it('handles an empty body — DELETE carries none', () => {
    expect(() => fingerprint('DELETE', '/v1/api-keys/key_1', undefined)).not.toThrow();
  });
});

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('handles scalars', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
  });

  it('rejects one character over', () => {
    expect(isValidIdempotencyKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidIdempotencyKey('')).toBe(false);
  });

  it.each([[undefined], [null], [42], [{}], [[]]])('rejects %p', (value) => {
    expect(isValidIdempotencyKey(value)).toBe(false);
  });
});
