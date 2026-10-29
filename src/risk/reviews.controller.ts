/**
 * `/v1/reviews` — RFC platform-v2 §8, the merchant's read-only view of payments Payzeno's risk
 * rules held. Merchants can see a review and its rules; only Payzeno staff can decide it
 * (`AdminReviewsController`). Reads ride `payment_intents:read`: a review is part of a payment.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Paginated, Review } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';

import { ReviewListQueryDto } from './dto/review-list-query.dto';
import { ReviewsService } from './reviews.service';

@Controller('v1/reviews')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class ReviewsController extends BaseController {
  constructor(private readonly reviews: ReviewsService) {
    super();
  }

  @Get()
  @RequiredScopes('payment_intents:read')
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: ReviewListQueryDto): Promise<Paginated<Review>> {
    return this.reviews.list(principal, { cursor: query.cursor, limit: query.effectiveLimit(), status: query.status });
  }

  @Get(':reviewId')
  @RequiredScopes('payment_intents:read')
  get(@CurrentPrincipal() principal: AuthPrincipal, @Param('reviewId') reviewId: string): Promise<Review> {
    return this.reviews.get(principal, reviewId);
  }
}
