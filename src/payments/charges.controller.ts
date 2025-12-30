/**
 * `/v1/charges` — api-surface.md §5b. Three reads, no writes.
 *
 * A charge is created by confirming a payment intent and changed by capture, settlement or a
 * refund. There is no `POST /v1/charges` and there will not be one: the day a merchant can
 * create a charge without an intent is the day the intent stops being the idempotency
 * boundary for the whole payment.
 *
 * `GET /:chargeId/ledger` is session-only. It returns the ledger's postings for the charge,
 * which is a finance view, and api-key integrations have `charges:read` for the charge itself.
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  Charge,
  ChargeId,
  ChargeLedgerResponse,
  ChargeStatus,
  Paginated,
  PaymentIntentId,
  SettlementBatchId,
} from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { ChargesService } from './charges.service';

@Controller('v1/charges')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class ChargesController extends BaseController {
  constructor(private readonly charges: ChargesService) {
    super();
  }

  @Get()
  @RequiredScopes('charges:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ListQueryDto,
    @Query('status') status?: ChargeStatus,
    @Query('payment_intent_id') paymentIntentId?: PaymentIntentId,
    @Query('settlement_batch_id') settlementBatchId?: SettlementBatchId,
  ): Promise<Paginated<Charge>> {
    return this.charges.list(principal, {
      ...query,
      limit: query.effectiveLimit(),
      status,
      payment_intent_id: paymentIntentId,
      settlement_batch_id: settlementBatchId,
    });
  }

  /**
   * `@ApiVersion('2026-01-15')` — the version that moved the flat `card_*` fields into the
   * nested `card` object. `ApiVersionInterceptor` reshapes the response for older callers;
   * the two integrations still pinned to `2025-06-01` are why it still exists.
   */
  @Get(':chargeId')
  @ApiVersion('2026-01-15')
  @RequiredScopes('charges:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('chargeId') chargeId: ChargeId,
  ): Promise<Charge> {
    return this.charges.get(principal, chargeId);
  }

  @Get(':chargeId/ledger')
  @UseGuards(SessionGuard)
  getLedger(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('chargeId') chargeId: ChargeId,
  ): Promise<ChargeLedgerResponse> {
    return this.charges.getLedger(principal, chargeId);
  }
}
