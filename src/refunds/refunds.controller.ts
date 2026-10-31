/**
 * `/v1/refunds` — api-surface.md §6.
 *
 * Three routes. The interesting one is the POST: it is `@Idempotent()` because a merchant's
 * retry after a socket hang-up must not refund twice, and `@RateLimit(60, 60)` because a
 * runaway refund loop is the fastest way to empty a merchant's balance.
 *
 * There is no `DELETE /v1/refunds/:id`. A refund that has not left for the acquirer is
 * cancelled by the acquirer webhook path, not by the merchant — domain-model §4.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, ChargeId, Paginated, Refund, RefundId } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { currentCorrelationId } from '../common/logging/request-context';
import { RefundListQueryDto } from '../common/pagination/filtered-list-query.dto';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundsService } from './refunds.service';

@Controller('v1/refunds')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class RefundsController extends BaseController {
  constructor(private readonly refunds: RefundsService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  @RateLimit(60, 60)
  @RequiredScopes('refunds:write')
  @AuditLog('refund.create', { resourceType: 'refund' })
  create(@CurrentPrincipal() principal: AuthPrincipal, @Body() dto: CreateRefundDto): Promise<Refund> {
    this.assertScope(principal, 'refunds:write');
    return this.refunds.create(principal, dto, currentCorrelationId());
  }

  @Get()
  @RequiredScopes('refunds:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: RefundListQueryDto,
    @Query('charge_id') chargeId?: ChargeId,
  ): Promise<Paginated<Refund>> {
    return this.refunds.list(principal, { ...query, limit: query.effectiveLimit(), charge_id: chargeId });
  }

  @Get(':refundId')
  @RequiredScopes('refunds:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('refundId') refundId: RefundId,
  ): Promise<Refund> {
    return this.refunds.get(principal, refundId);
  }
}
