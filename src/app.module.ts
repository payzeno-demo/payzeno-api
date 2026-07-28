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
import { SerializerInterceptor } from './common/interceptors/serializer.interceptor';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { StructuredLoggerMiddleware } from './common/middleware/structured-logger.middleware';
import { RedactionInterceptor } from './common/redaction/redaction.interceptor';
import { API_CONFIG, type ApiConfig } from './config/api-config.type';
import { buildDataSourceOptions } from './config/database.config';
import { DisputesModule } from './disputes/disputes.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { InternalModule } from './internal/internal.module';
import { JobsModule } from './jobs/jobs.module';
import { LedgerModule } from './ledger/ledger.module';
import { MerchantsModule } from './merchants/merchants.module';
import { MetaController } from './meta/meta.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { RefundsModule } from './refunds/refunds.module';
import { ReportingModule } from './reporting/reporting.module';
import { StaffModule } from './staff/staff.module';
import { SupportModule } from './support/support.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * The root connection. `synchronize` and `migrationsRun` are both false in
 * `buildDataSourceOptions` — the schema is owned by `src/migrations/` and by nothing else.
 */
const TYPEORM_ROOT = TypeOrmModule.forRootAsync({
  imports: [CommonModule],
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig) => buildDataSourceOptions(config),
});

/**
 * Global interceptors, registered in api-surface.md §1.5 order. Nest runs them outermost-first
 * on the way in and innermost-first on the way out, which is why `RedactionInterceptor` is
 * first (it must see the raw body before anything logs it) and `SerializerInterceptor` is last
 * (it must be the closest wrapper around the handler's return value).
 *
 * `RateLimitGuard` is the only global guard. Auth guards are per-controller: there is no single
 * default credential in this API — `/v1/payment_intents` takes an api key, `/v1/auth/me` takes
 * a session, `/internal/v1/*` takes a service secret — and a global auth guard with a
 * `@Public()` escape hatch means the day someone forgets the decorator, the route is open.
 */
const REQUEST_CHAIN = [
  { provide: APP_INTERCEPTOR, useClass: RedactionInterceptor },
  { provide: APP_GUARD, useClass: RateLimitGuard },
  { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  { provide: APP_INTERCEPTOR, useClass: ApiVersionInterceptor },
  { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  { provide: APP_INTERCEPTOR, useClass: SerializerInterceptor },
  { provide: APP_FILTER, useClass: HttpExceptionFilter },
  {
    provide: APP_PIPE,
    useFactory: () =>
      new ValidationPipe({
        // `forbidNonWhitelisted` turns an unknown field into a 422 rather than dropping it
        // silently. A merchant who sends `ammount` deserves to be told.
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        exceptionFactory: validationExceptionFactory,
      }),
  },
];

@Module({
  imports: [
    CommonModule,
    ApiModule,
    TYPEORM_ROOT,
    // `ScheduleModule.forRoot()` is NOT here. `JobsModule` imports it, exactly once in the
    // application — a second registration gives every `@Cron` two schedulers and every job
    // fires twice. See the header of jobs.module.ts.

    HealthModule,
    AuthModule,
    StaffModule,
    AuditModule,
    SupportModule,
    MerchantsModule,
    PaymentsModule,
    RefundsModule,
    DisputesModule,
    LedgerModule,
    BillingModule,
    WebhooksModule,
    EventsModule,
    NotificationsModule,
    InternalModule,
    JobsModule,
    ReportingModule,
  ],
  controllers: [MetaController],
  providers: [...REQUEST_CHAIN],
})
export class AppModule implements NestModule {
  /**
   * The middleware half of api-surface.md §1.5. Order inside a single `apply()` call is the
   * order Nest runs them, and it matters: `CorrelationIdMiddleware` falls back to the request
   * id, so `RequestIdMiddleware` has to have minted one already, and
   * `StructuredLoggerMiddleware` logs both, so it goes last.
   *
   * `forRoutes('*')` deliberately includes `/healthz` — a probe that is not in the access log
   * is a probe you cannot prove was ever made when the ALB claims the task was unhealthy.
