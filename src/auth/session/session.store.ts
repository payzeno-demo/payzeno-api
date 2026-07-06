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
