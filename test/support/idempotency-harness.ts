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

  private id(merchantId: string, livemode: boolean, key: string): string {
    return `${merchantId}:${livemode}:${key}`;
  }

  get(merchantId: string, livemode: boolean, key: string): Row | undefined {
    return this.rows.get(this.id(merchantId, livemode, key));
  }

  put(row: Row): void {
    this.rows.set(this.id(row.merchant_id, row.livemode, row.key), row);
  }

  expireLease(merchantId: string, key: string): void {
    for (const row of this.rows.values()) {
      if (row.merchant_id === merchantId && row.key === key) {
        row.lease_expires_at = new Date(0);
      }
    }
  }
}

/**
 * A `DataSource` whose `query()` recognises the four statements
 * `PostgresIdempotencyStore` issues. It matches on the leading verb and the target table,
 * not on whitespace, so reformatting the SQL does not break the double — but changing
 * *which* statements the store runs does, which is the point.
 */
function fakeDataSource(table: FakeIdempotencyTable): DataSource {
  const query = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const normalised = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    if (normalised.startsWith('INSERT INTO IDEMPOTENCY_RECORD')) {
      const [merchantId, livemode, key, fingerprint, lease, now, expires] = params as [
        string,
        boolean,
        string,
        string,
        Date,
        Date,
        Date,
      ];
      const existing = table.get(merchantId, livemode, key);

      const claimable =
        !existing ||
        (existing.state === 'in_progress' &&
          existing.lease_expires_at.getTime() < now.getTime() &&
          existing.fingerprint === fingerprint);

      if (!claimable) {
        return [];
      }

      table.put({
        merchant_id: merchantId,
        livemode,
        key,
        fingerprint,
        state: 'in_progress',
        response_status: null,
        response_body: null,
        lease_expires_at: lease,
        expires_at: expires,
      });
      return [{ claimed: true, state: 'in_progress', fingerprint, response_status: null, response_body: null, lease_expires_at: lease }];
    }

    if (normalised.startsWith('SELECT STATE, FINGERPRINT')) {
      const [merchantId, livemode, key] = params as [string, boolean, string];
      const row = table.get(merchantId, livemode, key);
      return row ? [row] : [];
    }

    if (normalised.includes("SET STATE = 'COMPLETED'")) {
      const [merchantId, livemode, key, status, body] = params as [string, boolean, string, number, string | null];
      const row = table.get(merchantId, livemode, key);
      if (row) {
        row.state = 'completed';
        row.response_status = status;
        row.response_body = body === null ? null : JSON.parse(body);
      }
      return [];
    }

    if (normalised.includes("SET STATE = 'FAILED'")) {
      const [merchantId, livemode, key, at] = params as [string, boolean, string, Date];
      const row = table.get(merchantId, livemode, key);
      if (row) {
        row.state = 'failed';
        row.lease_expires_at = at;
      }
      return [];
    }

    if (normalised.includes("SET STATE = 'IN_PROGRESS'")) {
      const [merchantId, livemode, key, fingerprint, lease] = params as [string, boolean, string, string, Date];
      const row = table.get(merchantId, livemode, key);
      if (row) {
        row.state = 'in_progress';
        row.fingerprint = fingerprint;
        row.lease_expires_at = lease;
        row.response_status = null;
        row.response_body = null;
      }
      return [];
    }

    throw new Error(`fakeDataSource: unrecognised statement — ${sql}`);
  };

  return { query } as unknown as DataSource;
}

export function buildPostgresIdempotencyStore(): IdempotencyHarness {
  const table = new FakeIdempotencyTable();
  const dataSource = fakeDataSource(table);
  const clock = new FixedClock('2026-01-15T12:00:00.000Z');

  return {
    store: new PostgresIdempotencyStore(dataSource, TEST_IDEMPOTENCY_CONFIG, clock, true),
    forMode: (livemode: boolean) =>
      new PostgresIdempotencyStore(dataSource, TEST_IDEMPOTENCY_CONFIG, clock, livemode),
    expireLease: (merchantId, key) => table.expireLease(merchantId, key),
    clock,
  };
}

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

/** Enough of ioredis for the CAS script, `get`, `set … PX` and `pttl`. */
export class FakeRedis {
  private readonly entries = new Map<string, RedisEntry>();

  constructor(private readonly clock: FixedClock) {}

  private live(key: string): RedisEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, _px: 'PX', ttlMs: number): Promise<'OK'> {
    this.entries.set(key, { value, expiresAtMs: this.clock.nowMs() + ttlMs });
    return 'OK';
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    return entry ? entry.expiresAtMs - this.clock.nowMs() : -2;
  }

  /**
   * Models the CAS script's semantics: claim when absent, re-claim a `failed` record with
   * the same fingerprint, otherwise return the stored record for the caller to inspect.
   */
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    fingerprint: string,
    claimJson: string,
    ttlMs: string,
  ): Promise<string> {
    const existing = this.live(key);
    if (!existing) {
      await this.set(key, claimJson, 'PX', Number(ttlMs));
      return 'claimed';
    }
    const decoded = JSON.parse(existing.value) as { state: string; fingerprint: string };
    if (decoded.state === 'failed' && decoded.fingerprint === fingerprint) {
      await this.set(key, claimJson, 'PX', Number(ttlMs));
      return 'claimed';
    }
    return existing.value;
  }

  expire(keySuffix: string): void {
    for (const [key, entry] of this.entries) {
      if (key.includes(keySuffix)) {
        entry.expiresAtMs = 0;
      }
    }
  }
}

export function buildRedisIdempotencyStore(): IdempotencyHarness {
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
