/**
 * AppModule — the composition root, and the hottest file in the repo (blueprint §9.3).
 *
 * Three things live here and nothing else:
 *
 *   1. the feature-module list (one `IMPORTS` edge per module, blueprint §2);
 *   2. the TypeORM root connection, built from `ApiConfig` and never from `process.env`;
 *   3. the global request chain of api-surface.md §1.5, in that exact order.
 *
 * `ConfigModule` is not listed directly. It is instantiated once, inside `CommonModule`, and
 * re-exported from there. Two `ConfigModule.forRoot()` calls would mean two `ApiConfig`
 * objects and — worse — two ioredis clients, two SQS clients and two of every connection the
 * config module opens. One instance, reached through the module that everything imports.
 * docs/adr/0001-nestjs-module-boundaries.md §3.
 *
 * `MetaController` is registered here rather than in a `MetaModule`. It has one dependency-free
 * handler; a module for it would be four lines of ceremony around a constant. It has been that
 * way for eleven months and it is the only controller in the repo without a home module.
 */
import { MiddlewareConsumer, Module, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiModule } from './api/api.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { RateLimitGuard } from './auth/guards/rate-limit.guard';
import { BillingModule } from './billing/billing.module';
import { CommonModule } from './common/common.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { validationExceptionFactory } from './common/filters/validation-exception.factory';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { ApiVersionInterceptor } from './common/interceptors/api-version.interceptor';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { RateLimitInterceptor } from './common/interceptors/rate-limit.interceptor';
