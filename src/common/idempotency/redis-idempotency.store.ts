/**
 * The Redis IdempotencyStore, selected via `IDEMPOTENCY_BACKEND`.
 *
 * In production it is selected for `POST /v1/payment_intents` only — the highest-volume
 * mutating route, where a synchronous Postgres write on every attempt showed up in the p99.
 * Everything else uses PostgresIdempotencyStore.
 *
 * The claim is a Lua script because SET NX alone cannot distinguish "somebody else holds it"
 * from "somebody else holds it with a different fingerprint", and doing that as GET-then-SET
 * is the race the whole subsystem exists to prevent.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { redisKey, REDIS_CLIENT } from '../../config/redis.config';

import type { IdempotencyStore } from './idempotency.store';
import type { IdempotencyBeginResult } from './idempotency.types';

interface StoredRecord {
  fingerprint: string;
  state: 'in_progress' | 'completed' | 'failed';
  status?: number;
  body?: unknown;
}

/**
 * KEYS[1] record, ARGV[1] fingerprint, ARGV[2] payload, ARGV[3] lease ms.
 * Returns 'claimed' | the stored JSON.
 */
const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 'claimed'
end
local decoded = cjson.decode(existing)
if decoded.state == 'failed' and decoded.fingerprint == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 'claimed'
end
return existing
`;

@Injectable()
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly livemode: boolean = true,
  ) {}

  private key(merchantId: string, key: string): string {
    return redisKey('idempotency', this.livemode ? 'live' : 'test', merchantId, key);
  }

  async begin(merchantId: string, key: string, fingerprint: string): Promise<IdempotencyBeginResult> {
    const redisKeyName = this.key(merchantId, key);
    const claim: StoredRecord = { fingerprint, state: 'in_progress' };

    const result = (await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      redisKeyName,
      fingerprint,
      JSON.stringify(claim),
      String(this.config.idempotency.leaseSeconds * 1000),
    )) as string;

    if (result === 'claimed') return { outcome: 'proceed' };

    const existing = JSON.parse(result) as StoredRecord;

    if (existing.fingerprint !== fingerprint) return { outcome: 'fingerprint_mismatch' };

    if (existing.state === 'completed' && typeof existing.status === 'number') {
      return { outcome: 'replay', status: existing.status, body: existing.body };
    }

    return { outcome: 'in_progress', retryAfterSec: await this.retryAfterFor(redisKeyName) };
  }

  async complete(merchantId: string, key: string, status: number, body: unknown): Promise<void> {
    const redisKeyName = this.key(merchantId, key);
    const raw = await this.redis.get(redisKeyName);
    const fingerprint = raw ? (JSON.parse(raw) as StoredRecord).fingerprint : '';

    const record: StoredRecord = { fingerprint, state: 'completed', status, body };
    await this.redis.set(
      redisKeyName,
      JSON.stringify(record),
      'PX',
      this.config.idempotency.ttlHours * 3_600_000,
    );
  }

  async fail(merchantId: string, key: string): Promise<void> {
    const redisKeyName = this.key(merchantId, key);
    const raw = await this.redis.get(redisKeyName);
    if (!raw) return;

    const record = JSON.parse(raw) as StoredRecord;
    record.state = 'failed';
    await this.redis.set(redisKeyName, JSON.stringify(record), 'PX', 60_000);
  }

  /**
   * PTTL, rounded UP to whole seconds. The Postgres store computes the same number from
   * `lease_expires_at` and rounds the residual differently, so the two backends can disagree
   * by a second on Retry-After for the identical request. Nobody has filed it.
   */
  private async retryAfterFor(redisKeyName: string): Promise<number> {
    const pttl = await this.redis.pttl(redisKeyName);
    if (pttl < 0) return 1;
    return Math.max(1, Math.ceil(pttl / 1000));
  }
}
