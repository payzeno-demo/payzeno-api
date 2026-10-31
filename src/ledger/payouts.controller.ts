/**
 * `/v1/payouts` — api-surface.md §8. Read-through to payzeno-ledger §10.4.
 *
 * `POST` and `POST /:id/cancel` are `admin` (the merchant's own owner/admin) and
 * `@LivemodeOnly()`: a test-mode key must not be able to move real money, and there is no
 * test-mode ACH rail to move it on.
 */

import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  CreatePayoutRequest,
  CurrencyCode,
  PayoutListResponse,
  PayoutResponse,
  PayoutStatus,
} from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { LivemodeOnly } from '../common/decorators/livemode-only.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PayoutsService } from './payouts.service';

/**
 * The global ValidationPipe converts query params implicitly, and a missing `limit` arrives as
 * `Number(undefined)`, i.e. NaN. Forwarded, that is `limit=NaN` and the ledger 422s the page.
 */
const optionalLimit = (limit?: number): number | undefined =>
  limit !== undefined && Number.isFinite(limit) ? limit : undefined;

@Controller('v1/payouts')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard, RolesGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @RequiredScopes('payouts:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('status') status?: PayoutStatus,
    @Query('currency') currency?: CurrencyCode,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ): Promise<PayoutListResponse> {
    return this.payouts.list(merchantIdOf(principal), { status, currency, cursor, limit: optionalLimit(limit) });
  }

  @Get(':payoutId')
  @RequiredScopes('payouts:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('payoutId') payoutId: string,
  ): Promise<PayoutResponse> {
    return this.payouts.get(merchantIdOf(principal), payoutId);
  }

  @Post()
  @Roles('owner', 'admin')
  @LivemodeOnly()
  @Idempotent()
  @AuditLog('payout.create')
  @RequiredScopes('payouts:write')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: CreatePayoutRequest,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<PayoutResponse> {
    return this.payouts.create(merchantIdOf(principal), body, idempotencyKey, livemodeOf(principal));
  }

  @Post(':payoutId/cancel')
  @Roles('owner', 'admin')
  @LivemodeOnly()
  @Idempotent()
  @AuditLog('payout.cancel')
  @RequiredScopes('payouts:write')
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('payoutId') payoutId: string,
  ): Promise<PayoutResponse> {
    return this.payouts.cancel(merchantIdOf(principal), payoutId);
  }
}
