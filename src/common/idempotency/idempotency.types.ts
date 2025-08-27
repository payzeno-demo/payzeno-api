/** Idempotency vocabulary. interfaces.md §2.5. */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@payzeno/contracts/guards';

/**
 * Re-exported so the twelve call sites that already import it from here keep working. The
 * implementation is NOT ours — see the note on `fingerprint` below.
 */
export { canonicalJson };

export interface IdempotencyKeyRef {
  merchantId: string;
  livemode: boolean;
  key: string;
}

