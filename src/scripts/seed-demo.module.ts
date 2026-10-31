/**
 * The demo seed's composition root — AppModule's feature graph without the request chain, the
 * jobs and the notification relay.
 *
 * Global for exactly two bindings the rest of the graph reads optionally:
 *   BACKGROUND_WORK = 'disabled'  EventsModule wires its consumers (their `onModuleInit` lookups
 *                                 still need every feature module present) but never starts
 *                                 their long-poll loops — those queues belong to the running API.
 *   PINO_ROOT                     a pino root writing to stderr, so the seed's stdout carries its
 *                                 JSON and nothing else.
 */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import pino from 'pino';

import { ApiModule } from '../api/api.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { CommonModule } from '../common/common.module';
import { PINO_ROOT } from '../common/logging/pino.logger';
import { BACKGROUND_WORK, type BackgroundWork } from '../common/runtime/background-work';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { buildDataSourceOptions } from '../config/database.config';
import { DisputesModule } from '../disputes/disputes.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { EmailModule } from '../notifications/email/email.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsModule } from '../refunds/refunds.module';
import { StaffModule } from '../staff/staff.module';
import { SupportModule } from '../support/support.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Global()
@Module({
  imports: [
    CommonModule,
    ApiModule,
    TypeOrmModule.forRootAsync({
      imports: [CommonModule],
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => buildDataSourceOptions(config),
    }),
    AuthModule,
    StaffModule,
    AuditModule,
    SupportModule,
    MerchantsModule,
    PaymentsModule,
    CheckoutModule,
    RefundsModule,
    DisputesModule,
    LedgerModule,
    BillingModule,
    WebhooksModule,
    EventsModule,
    // RFC platform-v2 identity: EmailService is a dependency of MerchantUsersService (global in
    // the app, so it has to be here too), and the seed marks onboarding approved.
    EmailModule,
    OnboardingModule,
  ],
  providers: [
    { provide: BACKGROUND_WORK, useValue: 'disabled' satisfies BackgroundWork },
    {
      provide: PINO_ROOT,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        pino(
          {
            level: config.runtime.logLevel,
            base: { service: 'payzeno-api-seed', env: config.runtime.nodeEnv },
            timestamp: pino.stdTimeFunctions.isoTime,
            messageKey: 'msg',
          },
          pino.destination(2),
        ),
    },
  ],
  exports: [BACKGROUND_WORK, PINO_ROOT],
})
export class SeedDemoModule {}
