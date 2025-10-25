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
    private readonly livemode: boolean = true,
  ) {}

  private key(merchantId: string, key: string): string {
    return redisKey('idempotency', this.livemode ? 'live' : 'test', merchantId, key);
  }

  async begin(merchantId: string, key: string, fingerprint: string): Promise<IdempotencyBeginResult> {
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
    const raw = await this.redis.get(redisKeyName);
    if (!raw) return;

  }
}
