/**
 * `/v1/payment_intents` — api-surface.md §5. The busiest surface in the product.
 *
 * The decorator stack is the security model, read top to bottom:
 *   @MerchantScoped()        every row this controller touches is narrowed to one tenant
 *   @UseGuards(...)          api key or dashboard session, then the scope check
 *   @Idempotent()            every mutating route — a retried POST must not double-charge
 *   @RateLimit(300, 60)      per api-surface §1.5; a create storm is either a bug or an attack
 *   @RequiredScopes(...)     api-key principals only; sessions carry roles instead
 *   @AuditLog(...)           one `audit_log` row per mutation, written by the interceptor
 *
 * `confirm` additionally accepts a `client_secret` principal, which is the browser's
 * credential and can reach exactly one intent.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  Paginated,
  PaymentIntent,
  PaymentIntentId,
  PaymentIntentStatus,
} from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { ClientSecretGuard } from '../auth/guards/client-secret.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { AcceptsClientSecret } from '../common/decorators/accepts-client-secret.decorator';
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { ReturnsSecretFields } from '../common/decorators/secret-fields.decorator';
import { PaymentIntentListQueryDto } from '../common/pagination/filtered-list-query.dto';
import { CancelPaymentIntentDto } from './dto/cancel-payment-intent.dto';
import { CapturePaymentIntentDto } from './dto/capture-payment-intent.dto';
import { ConfirmPaymentIntentDto } from './dto/confirm-payment-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { PaymentIntentsService } from './payment-intents.service';

@Controller('v1/payment_intents')
@MerchantScoped()
// Credential guards first, scope check last. ClientSecretGuard only answers on handlers marked
// `@AcceptsClientSecret()`, and it has to be in THIS list: a method-level guard would run after
// MerchantScopeGuard, which would then see no principal.
@UseGuards(ApiKeyGuard, SessionGuard, ClientSecretGuard, MerchantScopeGuard)
// `client_secret` is part of every PaymentIntent (contracts) — the merchant hands it to its page.
@ReturnsSecretFields('client_secret')
export class PaymentIntentsController extends BaseController {
  constructor(private readonly intents: PaymentIntentsService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  @RateLimit(300, 60)
  @RequiredScopes('payment_intents:write')
  @AuditLog('payment_intent.create', { resourceType: 'payment_intent' })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreatePaymentIntentDto,
  ): Promise<PaymentIntent> {
    this.assertScope(principal, 'payment_intents:write');
    return this.intents.create(principal, dto);
  }

  @Get()
  @RequiredScopes('payment_intents:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: PaymentIntentListQueryDto,
    @Query('status') status?: PaymentIntentStatus,
    @Query('customer_reference') customerReference?: string,
  ): Promise<Paginated<PaymentIntent>> {
    return this.intents.list(principal, {
      ...query,
      limit: query.effectiveLimit(),
      status,
      customer_reference: customerReference,
    });
  }

  @Get(':paymentIntentId')
  @ApiVersion('2026-01-15')
  @RequiredScopes('payment_intents:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('paymentIntentId') paymentIntentId: PaymentIntentId,
  ): Promise<PaymentIntent> {
    return this.intents.get(principal, paymentIntentId);
  }

  /**
   * Also reachable with a `client_secret` bearer — that is how the merchant's checkout page
   * confirms without ever holding an api key. `ClientSecretGuard` pins the principal to this
   * one intent, so the id in the path is checked against the credential, not against a tenant.
   */
  @Post(':paymentIntentId/confirm')
  @AcceptsClientSecret()
  @Idempotent()
  @RateLimit(300, 60)
  @RequiredScopes('payment_intents:write')
  @AuditLog('payment_intent.confirm', { resourceType: 'payment_intent', idParam: 'paymentIntentId' })
  confirm(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('paymentIntentId') paymentIntentId: PaymentIntentId,
    @Body() dto: ConfirmPaymentIntentDto,
  ): Promise<PaymentIntent> {
    return this.intents.confirm(principal, paymentIntentId, dto);
  }

  @Post(':paymentIntentId/capture')
  @Idempotent()
  @RequiredScopes('payment_intents:write')
  @AuditLog('payment_intent.capture', { resourceType: 'payment_intent', idParam: 'paymentIntentId' })
  capture(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('paymentIntentId') paymentIntentId: PaymentIntentId,
    @Body() dto: CapturePaymentIntentDto,
  ): Promise<PaymentIntent> {
    this.assertScope(principal, 'payment_intents:write');
    return this.intents.capture(principal, paymentIntentId, dto);
  }

  @Post(':paymentIntentId/cancel')
  @Idempotent()
  @RequiredScopes('payment_intents:write')
  @AuditLog('payment_intent.cancel', { resourceType: 'payment_intent', idParam: 'paymentIntentId' })
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('paymentIntentId') paymentIntentId: PaymentIntentId,
    @Body() dto: CancelPaymentIntentDto,
  ): Promise<PaymentIntent> {
    this.assertScope(principal, 'payment_intents:write');
    return this.intents.cancel(principal, paymentIntentId, dto);
  }
}
