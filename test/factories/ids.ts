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

const counters = new Map<string, number>();

export function nextId(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${prefix}${body(prefix, n)}`;
}

/** Stable id for a given prefix + label — useful when two factories must agree. */
export function fixedId(prefix: string, label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return `${prefix}${body(prefix, hash)}`;
}

export function resetIdCounters(): void {
  counters.clear();
}

function body(prefix: string, seed: number): string {
  // A ULID body is time-ordered; seeding from a counter keeps the ordering property the
  // cursor tiebreaker relies on without pulling in a real ULID generator.
  let value = seed;
  const chars: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    const index = (value + i * 7 + prefix.charCodeAt(0)) % CROCKFORD.length;
    chars.push(CROCKFORD[index]);
    value = Math.floor(value / 2) + 13;
  }
  // Keep the leading characters monotonic in `seed` so ids from one prefix sort by
  // creation order, exactly like the monotonic ULID factory in production.
  chars[0] = CROCKFORD[Math.min(seed, CROCKFORD.length - 1)];
  return chars.join('');
}

/**
 * Stable ids the factories and the guard specs share. `MerchantScopeGuard`'s specs need
 * two factories to agree on "the same merchant" without threading an argument through
 * every call site.
 */
export const TEST_MERCHANT_ID = fixedId('mch_', 'aurora');
export const TEST_OTHER_MERCHANT_ID = fixedId('mch_', 'borealis');
export const TEST_USER_ID = fixedId('usr_', 'aurora-owner');
export const TEST_API_KEY_ID = fixedId('key_', 'aurora-live');
export const TEST_PAYMENT_INTENT_ID = fixedId('pi_', 'aurora-order-4471');
export const TEST_CHARGE_ID = fixedId('ch_', 'aurora-order-4471');
