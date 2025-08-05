/**
 * ioredis wiring. One client, shared by the session store, the idempotency store, the rate
 * limiter and RedisLockService — four subsystems, one connection pool, one key prefix so an
 * ops `SCAN pz:api:*` finds everything payzeno-api owns and nothing else.
 */
import { Redis, type RedisOptions } from 'ioredis';

import type { ApiConfig } from './api-config.type';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export function buildRedisOptions(config: ApiConfig): RedisOptions {
  return {
    keyPrefix: config.redis.keyPrefix,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    // A lock or an idempotency lease that queues behind a reconnect is worse than one that
    // fails fast: the caller has a Postgres fallback, the queue has nothing.
    enableOfflineQueue: false,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
  };
}

export function createRedisClient(config: ApiConfig): Redis {
  return new Redis(config.redis.url, buildRedisOptions(config));
}

/** Namespaces used across the repo. Kept here so two features cannot collide. */
export const REDIS_NAMESPACES = {
  session: 'sess',
  csrf: 'csrf',
  idempotency: 'idem',
  rateLimit: 'rl',
  jobLock: 'lock',
} as const;

export function redisKey(namespace: keyof typeof REDIS_NAMESPACES, ...parts: string[]): string {
  return [REDIS_NAMESPACES[namespace], ...parts].join(':');
}
