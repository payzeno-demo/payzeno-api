/**
 * Deterministic, ULID-shaped ids for the factories.
 *
 * `isPayzenoId` (src/common/ids/id.prefix.ts) validates the body as 26 characters of
 * Crockford base32, and `decodeCursor` rejects anything that fails it. A factory that
 * minted `mch_000001` would therefore make every cursor and every `@IsPayzenoId` spec
 * pass or fail for the wrong reason, so the fixtures mint real-shaped ids — just
 * predictable ones, seeded per prefix so a failure message points at a stable value.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function nextId(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${prefix}${body(prefix, n)}`;
}

export const TEST_OTHER_MERCHANT_ID = fixedId('mch_', 'borealis');
export const TEST_CHARGE_ID = fixedId('ch_', 'aurora-order-4471');
