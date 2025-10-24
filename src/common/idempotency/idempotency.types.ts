/** Idempotency vocabulary. interfaces.md §2.5. */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@payzeno/contracts/guards';

/**
 * Re-exported so the twelve call sites that already import it from here keep working. The
 * implementation is NOT ours — see the note on `fingerprint` below.
 */
export { canonicalJson };

export type IdempotencyBeginResult =
  | { outcome: 'proceed' }
  | { outcome: 'replay'; status: number; body: unknown }
  | { outcome: 'in_progress'; retryAfterSec: number }
  | { outcome: 'fingerprint_mismatch' };

export interface IdempotencyKeyRef {
  merchantId: string;
  livemode: boolean;
  key: string;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * `sha256(method || '\n' || path || '\n' || canonical_json(body))`.
 *
 * Method and path are in the fingerprint deliberately: without them the same key reused
 * across two different endpoints has undefined behaviour, and the client that reuses a key
 * across endpoints is usually a framework doing it automatically. domain-model.md §0.3(a).
 *
 * `canonicalJson` comes from @payzeno/contracts and must never be reimplemented here. It is
 * the exact byte sequence payzeno-ledger's `app/domain/fingerprint.py` hashes for
 * `ledger_transaction.request_fingerprint`, and a one-byte disagreement between the two does
 * not error — it just produces two fingerprints for one logical request, never takes the
 * replay branch, and posts twice.
 *
 * There was a local copy here. It differed: `JSON.stringify(NaN)` returns the string `null`,
 * so a non-finite number silently hashed as a null instead of throwing the way the shared
 * implementation does.
 */
export function fingerprint(method: string, path: string, body: unknown): string {
  // A bodyless request (DELETE, and the two POSTs that take none) arrives as `undefined`, and
  // the shared canonicaliser throws on `undefined` at the root by design — "the caller did not
  // send the field" is not a value. Normalising to `null` here is this repo's decision about
  // what an absent body hashes as, made in one place rather than inside the shared function.
  const payload = body === undefined ? null : body;
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(payload)}`)
    .digest('hex');
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH;
}
