/**
 * `/v1/prices` — RFC platform-v2 §6. What a merchant charges, once or every period.
 * Api keys (`prices:read` / `prices:write`) and console sessions.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Paginated, Price } from '@payzeno/contracts';

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

import { CreatePriceDto, PriceListQueryDto } from './dto/price.dto';
import { PricesService } from './prices.service';

@Controller('v1/prices')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard, RolesGuard)
export class PricesController extends BaseController {
  constructor(private readonly prices: PricesService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Roles('admin')
  @Idempotent()
  @RequiredScopes('prices:write')
  @AuditLog('price.create', { resourceType: 'price' })
  create(@CurrentPrincipal() principal: AuthPrincipal, @Body() dto: CreatePriceDto): Promise<Price> {
    return this.prices.create(principal, dto);
  }

  @Get()
  @RequiredScopes('prices:read')
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: PriceListQueryDto): Promise<Paginated<Price>> {
    const active = query.active === undefined ? undefined : query.active === 'true';
    return this.prices.list(principal, { cursor: query.cursor, limit: query.effectiveLimit() }, active);
  }

  @Get(':priceId')
  @RequiredScopes('prices:read')
  get(@CurrentPrincipal() principal: AuthPrincipal, @Param('priceId') priceId: string): Promise<Price> {
    return this.prices.get(principal, priceId);
  }
}
