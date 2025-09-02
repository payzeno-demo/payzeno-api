/**
 * RefundsModule — blueprint §2's edge list: CommonModule, PaymentsModule (the charge
 * repository and the processor router), LedgerModule, EventsModule.
 *
 * It does NOT import MerchantsModule. A refund needs the charge and the acquirer, not the
 * merchant's configuration, and importing it would give this module a path to
 * MerchantOnboardingService — which is how a module graph turns into a ball of string.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundEntity } from './refund.entity';
import { RefundPolicyService } from './refund-policy.service';
import { RefundRepository } from './refund.repository';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { RefundStateMachine } from './state/refund.state-machine';

@Module({
  imports: [
    CommonModule,
    PaymentsModule,
    LedgerModule,
    EventsModule,
    TypeOrmModule.forFeature([RefundEntity]),
  ],
  controllers: [RefundsController],
  providers: [RefundsService, RefundRepository, RefundPolicyService, RefundStateMachine],
  // RefundPolicyService is exported for DisputesService: `is_charge_refundable` on a dispute
  // is the same computation, and two implementations of "how much is left" is one too many.
  exports: [RefundsService, RefundRepository, RefundPolicyService],
})
export class RefundsModule {}
