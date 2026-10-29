/**
 * RecurringBillingModule — RFC platform-v2 §6: prices, a merchant's customers' subscriptions,
 * and the renewal job.
 *
 * Separate from `BillingModule`, which is the invoices strangler (Payzeno billing merchants,
 * billing-legacy's `sub_`); nothing here touches it.
 *
 * One `forwardRef` pair with CheckoutModule, and it is the domain's own cycle: a subscription
 * starts at checkout (checkout → subscriptions), and a failed renewal is fixed at checkout
 * (renewals → a `setup` session, whose completion retries the renewal). The same documented
 * pattern as PaymentsModule ↔ RefundsModule.
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CheckoutModule } from '../../checkout/checkout.module';
import { CommonModule } from '../../common/common.module';
import { CustomersModule } from '../../customers/customers.module';
import { MerchantsModule } from '../../merchants/merchants.module';
import { PaymentsModule } from '../../payments/payments.module';

import { PriceEntity } from './price.entity';
import { PriceRepository } from './price.repository';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { SubscriptionNotices } from './subscription-notices';
import { SubscriptionRenewalJob } from './subscription-renewal.job';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import { SubscriptionEntity } from './subscription.entity';
import { SubscriptionRepository } from './subscription.repository';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [
    CommonModule,
    PaymentsModule,
    CustomersModule,
    MerchantsModule,
    forwardRef(() => CheckoutModule),
    TypeOrmModule.forFeature([PriceEntity, SubscriptionEntity]),
  ],
  controllers: [PricesController, SubscriptionsController],
  providers: [
    PricesService,
    PriceRepository,
    SubscriptionsService,
    SubscriptionRepository,
    SubscriptionNotices,
    SubscriptionRenewalService,
    SubscriptionRenewalJob,
  ],
  exports: [PricesService, PriceRepository, SubscriptionsService, SubscriptionRepository, SubscriptionRenewalService],
})
export class RecurringBillingModule {}
