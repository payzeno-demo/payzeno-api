/**
 * SessionStore — the dashboard session seam.
 *
 * Two implementations: `RedisSessionStore` in production, `InMemorySessionStore` for the
 * `NODE_ENV=test` boot and the dev compose profile, where standing up Redis to log into a
 * local console is friction with no upside.
 *
 * A session record is deliberately small. It holds the ids and the role, not the user row:
 * a role change must take effect on the next request, and a cached `full_name` in Redis is a
 * cache invalidation problem nobody signed up for.
 */
import type { MerchantId, StaffRole, UserId, UserRole } from '@payzeno/contracts';

/**
 * One record type covers both logins because they share a cookie, a store and a CSRF token.
 * The `kind` discriminates: a merchant user has `userId`/`merchantId`/`role`, a Payzeno
 * operator has `staffId`/`staffRole` and no merchant at all until they pass `?merchant_id=`.
 * Collapsing the two into one nullable-everything row is exactly what makes StaffGuard's
 * check a one-liner instead of a second session subsystem.
 */
export type SessionKind = 'merchant_user' | 'staff';

export interface SessionRecord {
  /** Opaque, 32 bytes of randomness. Never derived from the user id. */
  id: string;
  kind: SessionKind;
  userId: UserId | null;
  merchantId: MerchantId | null;
  role: UserRole | null;
  staffId: string | null;
  staffRole: StaffRole | null;
  /** Double-submit token; the same value is served in the readable `pz_csrf` cookie. */
  csrfToken: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  /** Truncated. Used by the console's "active sessions" list and by incident forensics. */
  userAgent: string | null;
  ip: string | null;
}

export interface SessionStore {
  create(record: SessionRecord, ttlSec: number): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Slides the TTL and refreshes `lastSeenAtMs`. Called on every authenticated request. */
  touch(sessionId: string, ttlSec: number): Promise<void>;
  destroy(sessionId: string): Promise<void>;
  /** Logout-everywhere, and what a password reset must call. */
  destroyAllForUser(userId: UserId): Promise<number>;
}

/** The subject a record's sessions are indexed under — merchant user or staff operator. */
export function subjectOf(record: SessionRecord): string {
  return record.kind === 'staff' ? (record.staffId ?? 'unknown') : (record.userId ?? 'unknown');
}

export const SESSION_STORE = Symbol('SESSION_STORE');

/**
 * Process-local store. Correct on one task, a lie on three — which is why it is only ever
 * bound when `NODE_ENV=test` or in the dev compose profile. `AuthModule` decides.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, { record: SessionRecord; expiresAtMs: number }>();

  async create(record: SessionRecord, ttlSec: number): Promise<void> {
    this.records.set(record.id, { record, expiresAtMs: Date.now() + ttlSec * 1000 });
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const held = this.records.get(sessionId);
    if (!held) return null;
    if (held.expiresAtMs <= Date.now()) {
      this.records.delete(sessionId);
      return null;
    }
    return held.record;
  }

  async touch(sessionId: string, ttlSec: number): Promise<void> {
    const held = this.records.get(sessionId);
    if (!held) return;
    held.record.lastSeenAtMs = Date.now();
    held.expiresAtMs = Date.now() + ttlSec * 1000;
  }

  async destroy(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }

  async destroyAllForUser(userId: UserId): Promise<number> {
    let removed = 0;
    for (const [id, held] of this.records) {
      if (subjectOf(held.record) === userId) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
