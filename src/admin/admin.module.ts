/**
 * AdminModule — the staff back office's API, `/v1/admin/*` (RFC platform-v2 §1).
 *
 * A reader of other modules' aggregates, never an owner of one: merchants and onboarding
 * decisions through OnboardingModule / MerchantsModule, disputes through DisputesModule's
 * repository, the reconciliation backlog through the ledger client, support tasks through
 * SupportModule, email history through the global EmailModule. StaffGuard and the staff audit
 * trail come from the global AuthModule. The risk review queue (`/v1/admin/reviews`) is not
 * here; it belongs to the risk workstream.
 */
import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module';
import { DisputesModule } from '../disputes/disputes.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { SupportModule } from '../support/support.module';

import { AdminMerchantsController } from './admin-merchants.controller';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminOperationsController } from './admin-operations.controller';
import { AdminOperationsService } from './admin-operations.service';

@Module({
  imports: [CommonModule, MerchantsModule, OnboardingModule, DisputesModule, LedgerModule, SupportModule],
  controllers: [AdminMerchantsController, AdminOperationsController],
  providers: [AdminMerchantsService, AdminOperationsService],
})
export class AdminModule {}
