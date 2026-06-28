/**
 * BillingModule — CommonModule, ApiModule, LedgerModule (the MIG swap target), EventsModule.
 *
 * `BillingLegacyClient` is built by a factory, like `LedgerHttpClient`, because it needs its
 * own timeout block and its own circuit breaker instance. The breaker settings are the ones
 * api-surface.md §13 contracts: 50% error threshold over 20 requests, 30s reset. A trip is a
 * `502 legacy_upstream_unavailable`, not a 500 — the legacy service being down is a known
 * operating state, not a defect in this repo.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiModule } from '../api/api.module';
import { DEFAULT_CLIENT_OPTIONS } from '../api/client';
import { CircuitBreakerRegistry } from '../api/circuit-breaker';
import { NoRetryPolicy } from '../api/retry.policy';
import { HTTP_TRANSPORT, type HttpTransport } from '../api/transport.interface';
import { CommonModule } from '../common/common.module';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { ApiConfig } from '../config/api-config.type';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BillingLegacyClient } from './billing-legacy.client';
import { InvoiceSourceResolver } from './invoice-source.resolver';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceProjectionEntity } from './projection/invoice-projection.entity';
import { InvoiceProjectionRepository } from './projection/invoice-projection.repository';
import { InvoiceProjectionService } from './projection/invoice-projection.service';

@Module({
  imports: [
    CommonModule,
    ApiModule,
    LedgerModule,
    EventsModule,
    TypeOrmModule.forFeature([InvoiceProjectionEntity]),
  ],
  controllers: [InvoicesController],
  providers: [
    {
      provide: BillingLegacyClient,
      inject: [ApiConfig, HTTP_TRANSPORT, PAYZENO_LOGGER, CircuitBreakerRegistry],
      useFactory: (
        config: ApiConfig,
        transport: HttpTransport,
        logger: PayzenoLogger,
        breakers: CircuitBreakerRegistry,
      ): BillingLegacyClient =>
        new BillingLegacyClient(
          config.billingLegacy,
          transport,
          {
            ...DEFAULT_CLIENT_OPTIONS,
            connectTimeoutMs: 2_000,
            // The nightly invoice generation job holds a MySQL table lock while it runs and
            // the list endpoint queues behind it. 15s is measured, not guessed.
            readTimeoutMs: 15_000,
            retries: 0,
            userAgent: 'payzeno-api/billing',
          },
          // No retries: the breaker is the resilience story here. Retrying into a service
          // that is already the reason the breaker is half-open is how you keep it open.
          new NoRetryPolicy(),
          logger,
          breakers,
        ),
    },
    InvoicesService,
    InvoiceSourceResolver,
    InvoiceProjectionService,
    InvoiceProjectionRepository,
  ],
  exports: [BillingLegacyClient, InvoiceProjectionService, InvoiceSourceResolver],
})
export class BillingModule {}
