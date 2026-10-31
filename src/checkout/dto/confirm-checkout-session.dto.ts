/**
 * `POST /v1/checkout/sessions/:id/confirm` body — `implements ConfirmCheckoutSessionRequest`.
 *
 * All optional: with a token (or a saved card's `payment_method_id`) it is a payment attempt,
 * with neither it resumes a payment waiting on 3-D Secure. `return_url` defaults to the hosted
 * page's own return route. `currency` + `fx_quote_id` pay in one of the session's
 * `currency_options`; the service checks the quote against the session.
 */
import { CURRENCIES } from '@payzeno/contracts';
import type { ConfirmCheckoutSessionRequest, CurrencyCode, FxQuoteId, PaymentMethodId } from '@payzeno/contracts';
import { IsBoolean, IsIn, IsOptional, IsUrl, MaxLength } from 'class-validator';


import { Redact } from '../../common/decorators/redact.decorator';
import { IsPayzenoId, IsVaultToken } from '../../common/validators/payzeno-id.validator';
import { FX_QUOTE_ID_PREFIX } from '../../fx/fx-quote.entity';
import { PAYMENT_METHOD_ID_PREFIX } from '../../payment-methods/payment-method.entity';

@Redact('payment_method_token')
export class ConfirmCheckoutSessionDto implements ConfirmCheckoutSessionRequest {
  @IsOptional()
  @IsVaultToken('pmt_')
  payment_method_token?: string;

  @IsOptional()
  @IsPayzenoId(PAYMENT_METHOD_ID_PREFIX)
  payment_method_id?: PaymentMethodId;

  @IsOptional()
  @IsBoolean()
  save_payment_method?: boolean;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: CurrencyCode;

  @IsOptional()
  @IsPayzenoId(FX_QUOTE_ID_PREFIX)
  fx_quote_id?: FxQuoteId;

  // http or https here; the environment's scheme rule is applied downstream.
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(2_048)
  return_url?: string;
}
