/**
 * IdempotencyStore — three operations, two implementations, one contract suite
 * (`idempotency.store.contract.spec.ts` runs the same table against both).
 *
 * `begin` is the interesting one. It must be atomic: claim-or-report, never
 * check-then-insert. Both stores implement it as a single conditional write —
 * `INSERT … ON CONFLICT DO UPDATE … WHERE` in Postgres, `SET NX` plus a Lua compare in
 * Redis. docs/adr/0004-idempotency-storage.md.
 */
import type { IdempotencyBeginResult } from './idempotency.types';

export interface IdempotencyStore {
  /**
   * Claims the key. Reclaims a row whose lease has expired — without that, a process that
   * dies mid-request returns 409 for that key for a full 24 hours (data-model.md §1.10).
   */
  begin(merchantId: string, key: string, fingerprint: string): Promise<IdempotencyBeginResult>;

  /** Stores the response for replay and releases the lease. */
  complete(merchantId: string, key: string, status: number, body: unknown): Promise<void>;

  /**
   * Marks the attempt failed. A failed attempt is retryable with the same key: a 500 is not
   * a business outcome and holding the key hostage for 24h helps nobody.
   */
  fail(merchantId: string, key: string): Promise<void>;
}

/** Both stores are constructed per livemode, so the mode is not on the method signature. */
