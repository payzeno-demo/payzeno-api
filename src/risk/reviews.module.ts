/**
 * ReviewsModule — RFC platform-v2 §8, the acting half: list reviews, and the analyst's
 * approve (capture) / decline (void). Sits above PaymentsModule and RiskModule, which is why it
 * is not part of RiskModule: the payment flows import the risk engine, and this imports the
 * payment flows.
 */
import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PaymentsModule } from '../payments/payments.module';

import { AdminReviewsController } from './admin-reviews.controller';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { RiskModule } from './risk.module';

@Module({
  imports: [CommonModule, PaymentsModule, RiskModule, MerchantsModule],
  controllers: [ReviewsController, AdminReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
