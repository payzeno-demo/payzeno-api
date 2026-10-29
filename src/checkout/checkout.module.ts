/**
 * CheckoutModule — hosted and embedded checkout sessions.
 *
 * Imports CommonModule, PaymentsModule (the intent behind every session, and its charges) and
 * MerchantsModule (the display name the page shows). Exports the repository for
 * `CheckoutSecretGuard`, which resolves it non-strictly, and the service for
 * `CheckoutExpiryJob`.
 *
 * RFC platform-v2 added CustomersModule (saved cards), FxModule (adaptive pricing), RiskModule
 * (the review a held payment shows) and RecurringBillingModule — the last one through a
 * `forwardRef`, see recurring-billing.module.ts for why that cycle is the domain's own.
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RecurringBillingModule } from '../billing/recurring/recurring-billing.module';
import { CommonModule } from '../common/common.module';
import { CustomersModule } from '../customers/customers.module';
import { FxModule } from '../fx/fx.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PaymentsModule } from '../payments/payments.module';
import { RiskModule } from '../risk/risk.module';

import { CheckoutPublicController } from './checkout-public.controller';
import { CheckoutSessionEntity } from './checkout-session.entity';
import { CheckoutSessionRepository } from './checkout-session.repository';
import { CheckoutSessionsController } from './checkout-sessions.controller';
import { CheckoutSessionsService } from './checkout-sessions.service';

@Module({
  imports: [
    CommonModule,
    PaymentsModule,
    MerchantsModule,
    CustomersModule,
    FxModule,
    RiskModule,
    forwardRef(() => RecurringBillingModule),
    TypeOrmModule.forFeature([CheckoutSessionEntity]),
  ],
  controllers: [CheckoutSessionsController, CheckoutPublicController],
  providers: [CheckoutSessionsService, CheckoutSessionRepository],
  exports: [CheckoutSessionsService, CheckoutSessionRepository],
})
export class CheckoutModule {}
