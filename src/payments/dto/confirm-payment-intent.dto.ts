/**
 * `POST /v1/payment_intents/:id/confirm` body — `implements ConfirmPaymentIntentRequest`.
 *
 * Both fields are optional and that is the interesting part: the common case is a confirm with
 * an empty body, because the token was attached at create time. The token here is an override
 * for the "customer changed their card on the review screen" flow.
 *
 * `return_url` must be https in production because it is where we send a cardholder mid-3DS.
 * An http return url downgrades the challenge and some issuers refuse the authentication
 * outright; a relative one sends them to our own domain, which is worse. Outside production
 * http is allowed for the local demo shops (see `assertCallbackUrl`).
 */

import { IsOptional, IsUrl, MaxLength } from 'class-validator';

import type { ConfirmPaymentIntentRequest, PaymentMethodToken } from '@payzeno/contracts';

import { Redact } from '../../common/decorators/redact.decorator';
import { IsVaultToken } from '../../common/validators/payzeno-id.validator';

@Redact('payment_method_token')
export class ConfirmPaymentIntentDto implements ConfirmPaymentIntentRequest {
  @IsOptional()
  @IsVaultToken('pmt_')
  payment_method_token?: PaymentMethodToken;

  @IsOptional()
  // http or https here; ConfirmPaymentFlow applies the environment's scheme rule
  // (`assertCallbackUrl` — https in production, either elsewhere).
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(2_048)
  return_url?: string;
}
