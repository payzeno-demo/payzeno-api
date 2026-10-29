/**
 * `/v1/settlements` — api-surface.md §8. The console-reachable settlement surface, and the
 * route arc INC's race arrives through.
 *
 * Every read here returns `MerchantSettlementBatch`, never `SettlementBatch`. The raw object
 * is acquirer-level and carries `expected_total_minor` / `posted_total_minor`, which are every
 * merchant's totals added together. `MerchantScopeGuard` cannot protect it — there is no
 * `merchant_id` on the object to scope — so the narrowing happens in
 * `LedgerReadThroughService.toMerchantView` and the wide type never reaches a controller.
 *
 * `POST /:batchId/items/:itemId/retry` is `@StaffOnly('finance')` and `@LivemodeOnly()`. It
 * maps the ledger's `409 settlement_locked` straight out: since PAY-2043 a retry that races a
 * sweep is a no-op, not a failure, and the console shows "already settling". Its RATE is a
 * signal, not an error-budget burn — see docs/runbooks/payzeno-api.md.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  MerchantSettlementBatch,
  Paginated,
  ReconciliationItem,
  ReconciliationItemStatus,
  SettlementBatchStatus,
} from '@payzeno/contracts';

import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { merchantIdOf, staffIdOf } from '../auth/principal/principal.factory';
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { LivemodeOnly } from '../common/decorators/livemode-only.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { LedgerReadThroughService } from './ledger-read-through.service';

interface RetryItemRequest {
  reason?: string;
}

/**
 * The global ValidationPipe converts query params implicitly, and a missing `limit` arrives as
 * `Number(undefined)`, i.e. NaN. Forwarded, that is `limit=NaN` and the ledger 422s the page.
 */
const optionalLimit = (limit?: number): number | undefined =>
  limit !== undefined && Number.isFinite(limit) ? limit : undefined;

@Controller('v1/settlements')
@MerchantScoped()
@UseGuards(SessionGuard, StaffGuard, MerchantScopeGuard)
export class SettlementsController {
  constructor(private readonly readThrough: LedgerReadThroughService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('currency') currency?: MerchantSettlementBatch['currency'],
    @Query('status') status?: SettlementBatchStatus,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ): Promise<Paginated<MerchantSettlementBatch>> {
    return this.readThrough.listSettlementBatches(merchantIdOf(principal), {
      currency,
      status,
      cursor,
      limit: optionalLimit(limit),
    });
  }

  @Get(':batchId')
  @ApiVersion('2026-01-15')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('batchId') batchId: string,
  ): Promise<MerchantSettlementBatch> {
    return this.readThrough.getSettlementBatch(merchantIdOf(principal), batchId);
  }

  @Get(':batchId/items')
  listItems(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('batchId') batchId: string,
    @Query('status') status?: ReconciliationItemStatus,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ): Promise<Paginated<ReconciliationItem>> {
    return this.readThrough.listSettlementItems(merchantIdOf(principal), batchId, {
      status,
      cursor,
      limit: optionalLimit(limit),
    });
  }

  /**
   * 202: the ledger accepts the retry and settles asynchronously. A `409 settlement_locked`
   * from the ledger surfaces unchanged (`LedgerRejectedException` → `HttpExceptionFilter`).
   */
  @Post(':batchId/items/:itemId/retry')
  @HttpCode(202)
  @StaffOnly('finance')
  @LivemodeOnly()
  @Idempotent()
  @AuditLog('settlement.item.retry')
  retryItem(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
    @Body() body: RetryItemRequest,
  ): Promise<ReconciliationItem> {
    return this.readThrough.retrySettlementItem(itemId, {
      requested_by: staffIdOf(principal) ?? `console:${batchId}`,
      reason: body?.reason,
    });
  }
}
