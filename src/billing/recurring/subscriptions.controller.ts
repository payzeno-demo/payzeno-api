/**
 * `/v1/subscriptions` — RFC platform-v2 §6. A merchant's customers' subscriptions (`csub_`).
 *
 * Most start at checkout (`mode: 'subscription'`); `POST` here is for a customer who already has
 * a saved card, and charges the first period before answering. Renewals are the job's.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Paginated, Subscription } from '@payzeno/contracts';

import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { SessionGuard } from '../../auth/guards/session.guard';
import { BaseController } from '../../common/base/base.controller';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../../common/decorators/current-principal.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../../common/decorators/required-scopes.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { CancelSubscriptionDto, CreateSubscriptionDto, SubscriptionListQueryDto } from './dto/price.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('v1/subscriptions')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard, RolesGuard)
export class SubscriptionsController extends BaseController {
  constructor(private readonly subscriptions: SubscriptionsService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Roles('admin')
  @Idempotent()
  @RequiredScopes('subscriptions:write')
  @AuditLog('subscription.create', { resourceType: 'subscription' })
  create(@CurrentPrincipal() principal: AuthPrincipal, @Body() dto: CreateSubscriptionDto): Promise<Subscription> {
    return this.subscriptions.create(principal, dto);
  }

  @Get()
  @RequiredScopes('subscriptions:read')
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: SubscriptionListQueryDto): Promise<Paginated<Subscription>> {
    return this.subscriptions.list(principal, {
      cursor: query.cursor,
      limit: query.effectiveLimit(),
      customer_id: query.customer_id,
      status: query.status,
    });
  }

  @Get(':subscriptionId')
  @RequiredScopes('subscriptions:read')
  get(@CurrentPrincipal() principal: AuthPrincipal, @Param('subscriptionId') subscriptionId: string): Promise<Subscription> {
    return this.subscriptions.get(principal, subscriptionId);
  }

  @Post(':subscriptionId/cancel')
  @HttpCode(200)
  @Roles('admin')
  @RequiredScopes('subscriptions:write')
  @AuditLog('subscription.cancel', { resourceType: 'subscription', idParam: 'subscriptionId' })
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<Subscription> {
    return this.subscriptions.cancel(principal, subscriptionId, dto);
  }
}
