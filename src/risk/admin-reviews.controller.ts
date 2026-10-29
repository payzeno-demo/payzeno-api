/**
 * `/v1/admin/reviews` — RFC platform-v2 §1/§8, the risk queue in the admin back office.
 *
 * Cross-tenant and staff-only: `@StaffOnly('risk')` (an `admin` operator passes too). Not
 * `@MerchantScoped()` — the queue is every merchant's, and the decision routes act on the
 * review's own merchant. Both decisions are audited into `staff_audit_log` by
 * AuditLogInterceptor, which picks the staff trail from the principal.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Paginated, Review } from '@payzeno/contracts';

import { StaffGuard } from '../auth/guards/staff.guard';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';

import { ReviewDecisionDto } from './dto/review-decision.dto';
import { ReviewListQueryDto } from './dto/review-list-query.dto';
import { ReviewsService } from './reviews.service';

@Controller('v1/admin/reviews')
@UseGuards(StaffGuard)
@StaffOnly('risk')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query() query: ReviewListQueryDto): Promise<Paginated<Review>> {
    return this.reviews.listAll({
      cursor: query.cursor,
      limit: query.effectiveLimit(),
      status: query.status,
      merchant_id: query.merchant_id,
    });
  }

  @Post(':reviewId/approve')
  @HttpCode(200)
  @AuditLog('review.approve', { resourceType: 'review', idParam: 'reviewId' })
  approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reviewId') reviewId: string,
    @Body() dto: ReviewDecisionDto,
  ): Promise<Review> {
    return this.reviews.approve(principal, reviewId, dto);
  }

  @Post(':reviewId/decline')
  @HttpCode(200)
  @AuditLog('review.decline', { resourceType: 'review', idParam: 'reviewId' })
  decline(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reviewId') reviewId: string,
    @Body() dto: ReviewDecisionDto,
  ): Promise<Review> {
    return this.reviews.decline(principal, reviewId, dto);
  }
}
