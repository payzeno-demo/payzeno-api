/**
 * `/v1/checkout/sessions` — the merchant's side of hosted and embedded checkout.
 *
 * Every checkout route lives under `/v1/checkout/`: on `pay.localhost` / `pay.payzeno.com`
 * nginx proxies that prefix and nothing else to this service.
 *
 * Create is server-to-server only — an api key with `checkout_sessions:write`. Reads also take a
 * console session. The shopper's half (`/:id/public`, `/:id/confirm`) is
 * `CheckoutPublicController`, behind the session's own secret.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  CheckoutSession,
  CheckoutSessionStatus,
  Paginated,
} from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { ReturnsSecretFields } from '../common/decorators/secret-fields.decorator';
import { PermissionDeniedException } from '../common/errors/auth.exceptions';
import { StatusListQueryDto } from '../common/pagination/filtered-list-query.dto';

import { CheckoutSessionsService } from './checkout-sessions.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@Controller('v1/checkout/sessions')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard)
// Embedded mode: the merchant passes the session's `client_secret` to `Payzeno.mount()`.
@ReturnsSecretFields('client_secret')
export class CheckoutSessionsController extends BaseController {
  constructor(private readonly sessions: CheckoutSessionsService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  @RequiredScopes('checkout_sessions:write')
  @AuditLog('checkout_session.create', { resourceType: 'checkout_session' })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<CheckoutSession> {
    // The merchant's server creates sessions; the console has no business doing it.
    if (principal.kind !== 'api_key') {
      throw new PermissionDeniedException('Checkout sessions are created with a secret api key', {
        reason: 'api_key_required',
      });
    }
    return this.sessions.create(principal, dto);
  }

  @Get()
  @RequiredScopes('checkout_sessions:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: StatusListQueryDto,
    @Query('status') status?: CheckoutSessionStatus,
  ): Promise<Paginated<CheckoutSession>> {
    return this.sessions.list(principal, { ...query, limit: query.effectiveLimit() }, status);
  }

  @Get(':id')
  @RequiredScopes('checkout_sessions:read')
  get(@CurrentPrincipal() principal: AuthPrincipal, @Param('id') id: string): Promise<CheckoutSession> {
    return this.sessions.get(principal, id);
  }
}
