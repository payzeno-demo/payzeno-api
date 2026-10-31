/**
 * `GET /v1/balance` — api-surface.md §8.
 *
 * Guard composition note (repo-wide): the auth guards extend `BaseAuthGuard`, which returns
 * true immediately when a principal is already attached to the request. Listing two of them is
 * therefore an OR, not an AND, and expresses the contract's `apikey | session` marker.
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CURRENCIES, type AuthPrincipal, type Balance, type CurrencyCode } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { ValidationException } from '../common/errors/api.exception';

import { BalanceService } from './balance.service';
import type { BalanceList } from './ledger.types';

@Controller('v1/balance')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class BalanceController {
  constructor(private readonly balances: BalanceService) {}

  /** `?currency=` → that `Balance`. No currency → `{ data: Balance[] }`, one per currency held. */
  @Get()
  @RequiredScopes('balance:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('currency') currency?: CurrencyCode,
  ): Promise<Balance | BalanceList> {
    const merchantId = merchantIdOf(principal);
    if (!currency) {
      return this.balances.list(merchantId, livemodeOf(principal));
    }
    if (!(CURRENCIES as readonly string[]).includes(currency)) {
      throw new ValidationException('Unknown currency', [
        { path: 'currency', code: 'invalid_value', message: CURRENCIES.join(', ') },
      ]);
    }
    return this.balances.get(merchantId, currency, livemodeOf(principal));
  }
}
