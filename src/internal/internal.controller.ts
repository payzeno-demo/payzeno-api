/**
 * InternalController — api-surface.md §9b, all six routes.
 *
 * Belt and braces on every handler: `@InternalOnly()` is the marker nginx's `^/internal/`
 * deny rule and terraform's `rule_api_internal_deny` audit against, and
 * `InternalServiceGuard` is what actually refuses the request when both of those are
 * misconfigured. Neither is redundant — the decorator is a claim and the guard is the check.
 *
 * There is no merchant scope here. The callers are payzeno-ledger and
 * payzeno-billing-legacy, both of which are trusted to name the tenant they mean, so
 * `MerchantScopeGuard` deliberately does not run: it resolves scope from a merchant
 * principal and there is none.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type {
  BankAccount,
  Charge,
  IsoTimestamp,
  Merchant,
  MerchantId,
  WebhookEndpoint,
} from '@payzeno/contracts';

import { InternalServiceGuard } from '../auth/guards/internal-service.guard';
import { AuditLog, CurrentPrincipal, InternalOnly } from '../common/decorators';
import type { AuthPrincipal } from '@payzeno/contracts';

import { IsPayzenoId } from '../common/validators/payzeno-id.validator';

import {
  InternalService,
  type CreateSupportTaskInput,
  type InternalCallerName,
  type MarkChargeSettledInput,
} from './internal.service';

/**
 * The two write bodies, as classes.
 *
 * They were interfaces for most of a year, and `@Body() body: SomeInterface` means
 * `ValidationPipe` gets no metatype and validates nothing at all — it does not warn, it just
 * passes the object straight through. These are the routes payzeno-ledger reaches during
 * remediation, so "nothing errors and the wrong id goes in" is the exact failure mode we can
 * least afford. `@IsPayzenoId(prefix)` also catches a `ch_` id in a `txn_` field, which is a
 * transposition somebody makes eventually at 03:00.
 *
 * Declared here rather than in `dto/` for the same reason `InviteUserDto` is: two classes used
 * by one controller do not need a directory.
 */
export class MarkChargeSettledDto implements MarkChargeSettledInput {
  @IsPayzenoId('sb_')
  settlement_batch_id!: string;

  @IsString()
  @Post('charges/:chargeId/settled')
  @InternalOnly('payzeno-ledger')
  @InternalOnly('payzeno-ledger', 'payzeno-billing-legacy')
  async listWebhookEndpoints(
    @Query('merchant_id') merchantId: MerchantId,
    @Query('status') status: 'enabled' | 'disabled' | undefined,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<{ data: WebhookEndpoint[]; has_more: boolean }> {
    return this.internal.listWebhookEndpoints(merchantId, status, callerOf(principal));
  }

  /**
   * arc INC — the ledger's `settlement.duplicate_detected` branch, and the legacy biller's
   * dunning escalations. `the-incident.md` §8.
   */
  @HttpCode(201)
  /** Fallback for a stale `bank_account_projection`. Token only, never the number. */
  @Get('bank-accounts/:bankAccountId')
}
