import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';

import type { ApiConfig } from 'src/config/api-config.type';
import type { IdempotencyStore } from 'src/common/idempotency/idempotency.store';
import { PostgresIdempotencyStore } from 'src/common/idempotency/postgres-idempotency.store';
import { RedisIdempotencyStore } from 'src/common/idempotency/redis-idempotency.store';

import { FixedClock } from './fixed-clock';

/**
 * Backing doubles for the two `IdempotencyStore` implementations.
 *
 * Both stores talk to their backend in its own dialect — the Postgres one issues raw SQL
 * with an `ON CONFLICT … WHERE` reclaim predicate, the Redis one runs a Lua CAS script.
 * The doubles below model the *storage semantics* those statements depend on (a unique
 * key, a conditional claim, a TTL), so the code under test is the real store, including
 * its real branching. A double that stubbed `begin()` would test nothing.
 */

export interface IdempotencyHarness {
  store: IdempotencyStore;
  /** Same backend, other livemode — for the keyspace-separation assertion. */
  forMode(livemode: boolean): IdempotencyStore;
  /** Ages the holder's lease past expiry without waiting for wall-clock time. */
  expireLease(merchantId: string, key: string): void;
  clock: FixedClock;
}

export const TEST_IDEMPOTENCY_CONFIG = {
  idempotency: { leaseSeconds: 30, ttlHours: 24, backend: 'postgres' },
} as unknown as ApiConfig;

interface Row {
  merchant_id: string;
  livemode: boolean;
  key: string;
  fingerprint: string;
  state: 'in_progress' | 'completed' | 'failed';
  response_status: number | null;
  response_body: unknown;
  lease_expires_at: Date;
  expires_at: Date;
}

/** A Map keyed on `uq_idempotency_record (merchant_id, livemode, key)`. */
class FakeIdempotencyTable {
  private readonly rows = new Map<string, Row>();

  private live(key: string): RedisEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  const clock = new FixedClock('2026-01-15T12:00:00.000Z');
  const redis = new FakeRedis(clock);

  return {
    store: new RedisIdempotencyStore(redis as unknown as Redis, TEST_IDEMPOTENCY_CONFIG, true),
    forMode: (livemode: boolean) =>
      new RedisIdempotencyStore(redis as unknown as Redis, TEST_IDEMPOTENCY_CONFIG, livemode),
    expireLease: (_merchantId, key) => redis.expire(key),
    clock,
  };
}
