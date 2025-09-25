/**
 * DistributedLock — the seam `ScheduledJob.withLock` needs.
 *
 * Nine jobs run in every task. Without a lease, `OutboxDrainJob` on a 5s cron in three tasks
 * publishes every event three times; `RiskEvaluationJob` restricts a merchant three times and
 * emits three `merchant.status_changed` events. SKIP LOCKED saves the outbox specifically;
 * nothing saves the others.
 *
 * Concretes: RedisLockService (SET NX PX), InMemoryLock (single-task dev + `jobs --dry-run`).
 */
export interface LockHandle {
  name: string;
  token: string;
  expiresAtMs: number;
}

export interface DistributedLock {
  /** Returns null when another holder has the lease. Never blocks. */
  acquire(name: string, ttlSec: number): Promise<LockHandle | null>;

  /** Releases only if we still hold it — a lapsed lease belongs to somebody else now. */
  release(handle: LockHandle): Promise<boolean>;

  /** Extends our own lease. Used by jobs whose runtime is data-dependent. */
  extend(handle: LockHandle, ttlSec: number): Promise<boolean>;
}

export const DISTRIBUTED_LOCK = Symbol('DISTRIBUTED_LOCK');

/**
 * Process-local lock. Correct on one task and a lie on three, which is exactly why the
 * production wiring is RedisLockService and this one is only reachable from the dev compose
 * profile and the dry-run CLI.
 */
export class InMemoryLock implements DistributedLock {
  private readonly held = new Map<string, LockHandle>();

  async acquire(name: string, ttlSec: number): Promise<LockHandle | null> {
    const now = Date.now();
    const existing = this.held.get(name);

    if (existing && existing.expiresAtMs > now) return null;

    const handle: LockHandle = {
      name,
      token: `${now}-${Math.random().toString(36).slice(2)}`,
      expiresAtMs: now + ttlSec * 1000,
    };
    this.held.set(name, handle);
    return handle;
  }

  async release(handle: LockHandle): Promise<boolean> {
    const current = this.held.get(handle.name);
    if (current?.token !== handle.token) return false;
    this.held.delete(handle.name);
    return true;
  }

  async extend(handle: LockHandle, ttlSec: number): Promise<boolean> {
    const current = this.held.get(handle.name);
    if (current?.token !== handle.token) return false;
    current.expiresAtMs = Date.now() + ttlSec * 1000;
    return true;
  }
}
