/**
 * `GET /v1/balance` — api-surface.md §8.
 *
 * Guard composition note (repo-wide): the auth guards extend `BaseAuthGuard`, which returns
 * true immediately when a principal is already attached to the request. Listing two of them is
 * therefore an OR, not an AND, and expresses the contract's `apikey | session` marker.
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Balance, CurrencyCode } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BalanceService } from './balance.service';

@Controller('v1/balance')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class BalanceController {
  constructor(private readonly balances: BalanceService) {}

  @Get()
  @RequiredScopes('balance:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('currency') currency?: CurrencyCode,
  ): Promise<Balance> {
    const merchantId = merchantIdOf(principal);
    return this.balances.get(merchantId, currency ?? 'USD', livemodeOf(principal));
  }
}
