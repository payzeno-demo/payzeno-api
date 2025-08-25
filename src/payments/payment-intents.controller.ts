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
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { CancelPaymentIntentDto } from './dto/cancel-payment-intent.dto';
import { CapturePaymentIntentDto } from './dto/capture-payment-intent.dto';
import { ConfirmPaymentIntentDto } from './dto/confirm-payment-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { PaymentIntentsService } from './payment-intents.service';

@Controller('v1/payment_intents')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
export class PaymentIntentsController extends BaseController {
  constructor(private readonly intents: PaymentIntentsService) {
    super();
  }

  @Post()
  @AuditLog('payment_intent.create', { resourceType: 'payment_intent' })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreatePaymentIntentDto,
  ): Promise<PaymentIntent> {
    this.assertScope(principal, 'payment_intents:write');
    return this.intents.create(principal, dto);
  }

  @Get(':paymentIntentId')
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
