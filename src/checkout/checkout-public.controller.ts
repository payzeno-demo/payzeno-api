/**
 * The shopper's half of `/v1/checkout/sessions` — what `pay.payzeno.com` calls.
 *
 * `CheckoutSecretGuard` is the only credential: the session's own `cs_…_secret_…`, pinned to
 * `:id`, carrying the session's livemode. No `MerchantScopeGuard` — the principal is pinned to
 * one session's intent rather than to a tenant, and the guard has already refused any other id.
 *
 * Both routes read the shopper's country from the pay host's `X-Payzeno-Geo-Country` (and the
 * non-production `X-Payzeno-Geo-Override`): it prices `currency_options` and feeds the risk
 * rules (RFC platform-v2 §7–§9).
 */
import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, CheckoutSessionPublic } from '@payzeno/contracts';

import { CheckoutSecretGuard } from '../auth/guards/checkout-secret.guard';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { ReturnsSecretFields } from '../common/decorators/secret-fields.decorator';

import { CheckoutSessionsService } from './checkout-sessions.service';
import { ConfirmCheckoutSessionDto } from './dto/confirm-checkout-session.dto';

@Controller('v1/checkout/sessions')
@UseGuards(CheckoutSecretGuard)
// `payment.client_secret` is what the page tokenises the card with at the vault.
@ReturnsSecretFields('client_secret')
export class CheckoutPublicController {
  constructor(private readonly sessions: CheckoutSessionsService) {}

  @Get(':id/public')
  getPublic(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<CheckoutSessionPublic> {
    return this.sessions.getPublic(principal, id, this.sessions.shopperFrom(headers));
  }

  /** A decline answers 200 with `payment.last_error` — see `CheckoutSessionsService.confirm`. */
  @Post(':id/confirm')
  @HttpCode(200)
  @Idempotent()
  @RateLimit(30, 60)
  @AuditLog('checkout_session.confirm', { resourceType: 'checkout_session', idParam: 'id' })
  confirm(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: ConfirmCheckoutSessionDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<CheckoutSessionPublic> {
    return this.sessions.confirm(principal, id, dto, this.sessions.shopperFrom(headers));
  }
}
