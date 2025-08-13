/**
 * CommonModule — the shared kernel. Layer 0.
 *
 * It imports ConfigModule and NOTHING else, and every other module in the repo imports it.
 * That is the whole dependency rule in one sentence: config at the bottom, common on top of
 * it, features on top of common, nothing pointing back down the other way.
 *
 * Deliberately not `@Global()`. A global module makes `IMPORTS` invisible — you cannot answer
 * "who uses the idempotency store" from the module graph, only by grepping. Fifteen explicit
 * `imports: [CommonModule]` lines are worth that. docs/adr/0001-nestjs-module-boundaries.md.
 *
 * The bindings that matter here are the seams, each with two production implementations:
 *
 *   PAYZENO_LOGGER   → PinoPayzenoLogger   (NoopLogger in `jobs --dry-run`)
 *   FeatureFlags     → EnvFeatureFlags     (StaticFeatureFlags in test-app.ts / dry-run)
 *   CLOCK            → SystemClock         (FixedClock in test/support)
 *   DISTRIBUTED_LOCK → RedisLockService    (InMemoryLock in the dev compose profile)
 *   IDEMPOTENCY_STORE→ Postgres | Redis, chosen by IDEMPOTENCY_BACKEND
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { ConfigModule } from '../config/config.module';

import { HttpExceptionFilter } from './filters/http-exception.filter';
import { EnvFeatureFlags } from './flags/env-feature-flags';
import { FeatureFlags } from './flags/feature-flags';
import { IdempotencyRecord } from './idempotency/idempotency-record.entity';
import {
  IdempotencyInterceptor,
  POSTGRES_IDEMPOTENCY_STORE,
  REDIS_IDEMPOTENCY_STORE,
} from './idempotency/idempotency.interceptor';
import type { IdempotencyStore } from './idempotency/idempotency.store';
import { IDEMPOTENCY_STORE } from './idempotency/idempotency.types';
import { PostgresIdempotencyStore } from './idempotency/postgres-idempotency.store';
import { RedisIdempotencyStore } from './idempotency/redis-idempotency.store';
import { IdFactory } from './ids/id.factory';
import { ApiVersionInterceptor } from './interceptors/api-version.interceptor';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';
import { RateLimitInterceptor } from './interceptors/rate-limit.interceptor';
import { SerializerInterceptor } from './interceptors/serializer.interceptor';
import { DISTRIBUTED_LOCK } from './lock/distributed-lock';
import { RedisLockService } from './lock/redis-lock.service';
import { PAYZENO_LOGGER } from './logging/logger';
import { PinoPayzenoLogger } from './logging/pino.logger';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { StructuredLoggerMiddleware } from './middleware/structured-logger.middleware';
import { TransactionManager } from './persistence/transaction.manager';
import { CLOCK } from './time/clock';
import { SystemClock } from './time/system.clock';
import { RedactionInterceptor } from './redaction/redaction.interceptor';

const SEAMS = [
  { provide: PAYZENO_LOGGER, useClass: PinoPayzenoLogger },
  { provide: FeatureFlags, useClass: EnvFeatureFlags },
  { provide: CLOCK, useClass: SystemClock },
  { provide: DISTRIBUTED_LOCK, useClass: RedisLockService },
];

export class CommonModule {}
