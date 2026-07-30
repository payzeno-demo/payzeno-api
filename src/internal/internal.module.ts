/**
 * InternalModule — the service-to-service surface.
 *
 * It imports the feature modules it delegates to rather than reaching into their
 * repositories, so that a rule enforced in `MerchantsService` (say, that a suspended
 * merchant is still readable but never mutable) applies identically whether the caller is the
 * console or the ledger. Two code paths to the same table is how they drift.
 */
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PaymentsModule } from '../payments/payments.module';
import { SupportModule } from '../support/support.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    AuditModule,
    MerchantsModule,
    PaymentsModule,
    WebhooksModule,
    SupportModule,
  ],
  controllers: [InternalController],
  providers: [InternalService],
  exports: [InternalService],
})
export class InternalModule {}
