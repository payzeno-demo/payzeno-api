/**
 * `POST /v1/payment_intents/:id/confirm` body — `implements ConfirmPaymentIntentRequest`.
 *
 * Both fields are optional and that is the interesting part: the common case is a confirm with
 * an empty body, because the token was attached at create time. The token here is an override
 * for the "customer changed their card on the review screen" flow.
 *
 * `return_url` is validated as an https URL because it is where we send a cardholder mid-3DS.
 * An http return url downgrades the challenge and some issuers refuse the authentication
 * outright; a relative one sends them to our own domain, which is worse.
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
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @MaxLength(2_048)
  return_url?: string;
}
