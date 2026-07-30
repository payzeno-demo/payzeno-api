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

  @IsISO8601({ strict: true })
  settled_at!: IsoTimestamp;

  @IsPayzenoId('txn_')
  transaction_id!: string;
}

export class CreateSupportTaskDto implements CreateSupportTaskInput {
  @IsString()
  @MaxLength(64)
  kind!: string;

  @IsPayzenoId('mch_')
  merchant_id!: MerchantId;

  /** Null for a task that is about a merchant rather than a single charge. */
  @IsOptional()
  @IsPayzenoId('ch_')
  charge_id?: string | null;

  @IsIn(['low', 'medium', 'high', 'critical'])
  severity!: 'low' | 'medium' | 'high' | 'critical';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(20_000)
  body!: string;

  /**
   * The bus `EventEnvelope.id` this task was opened from. `SupportTasksService` dedupes on it,
   * which is what stops an at-least-once `settlement.duplicate_detected` opening the same task
   * twice for the same charge.
   */
  @IsString()
  @MaxLength(64)
  source_event_id!: string;
}

@Controller('internal/v1')
@UseGuards(InternalServiceGuard)
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  /** payzeno-ledger config reads; payzeno-billing-legacy `MerchantBillingProfile` sync. */
  @Get('merchants/:merchantId')
  @InternalOnly('payzeno-ledger', 'payzeno-billing-legacy')
  async getMerchant(
    @Param('merchantId') merchantId: MerchantId,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<Merchant> {
    return this.internal.getMerchant(merchantId, callerOf(principal));
  }

  /** payzeno-ledger, reconciling an orphaned item against a charge it cannot resolve. */
  @Get('charges/:chargeId')
  @InternalOnly('payzeno-ledger')
  async getCharge(
    @Param('chargeId') chargeId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<Charge> {
    return this.internal.getCharge(chargeId, callerOf(principal));
  }

  /**
   * The out-of-band settle. Reached during the PAY-2041 remediation for the charges no
   * `settlement.completed` chunk ever covered, and by `UnsettledChargeSweepJob`'s manual
   * counterpart since.
   */
  @Post('charges/:chargeId/settled')
  @InternalOnly('payzeno-ledger')
  @AuditLog('charge.settled.out_of_band', { resourceType: 'charge', idParam: 'chargeId' })
  async markChargeSettled(
    @Param('chargeId') chargeId: string,
    @Body() body: MarkChargeSettledDto,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<Charge> {
    return this.internal.markChargeSettled(chargeId, body, callerOf(principal));
  }

  /** The ledger's fanout-worthiness check. Never served from a projection. */
  @Get('webhook_endpoints')
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
  @Post('support-tasks')
  @HttpCode(201)
  @InternalOnly('payzeno-ledger', 'payzeno-billing-legacy')
  @AuditLog('support_task.open', { resourceType: 'support_task' })
  async createSupportTask(
    @Body() body: CreateSupportTaskDto,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<{ id: string }> {
    return this.internal.createSupportTask(body, callerOf(principal));
  }

  /** Fallback for a stale `bank_account_projection`. Token only, never the number. */
  @Get('bank-accounts/:bankAccountId')
  @InternalOnly('payzeno-ledger')
  async getBankAccount(
    @Param('bankAccountId') bankAccountId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<BankAccount> {
    return this.internal.getBankAccount(bankAccountId, callerOf(principal));
  }
}

/**
 * The guard has already proved the principal is `internal_service`; this narrows it for the
 * service layer so a caller name never has to be reconstructed from a header downstream.
 */
function callerOf(principal: AuthPrincipal): InternalCallerName {
  return principal.kind === 'internal_service' ? principal.service : 'payzeno-ledger';
}
