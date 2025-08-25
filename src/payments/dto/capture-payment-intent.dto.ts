/**
 * `POST /v1/payment_intents/:id/capture` body — `implements CapturePaymentIntentRequest`.
 *
 * One optional field. Omitting it captures the full authorised amount; supplying a smaller one
 * is a partial capture, which releases the remainder of the hold at the network and cannot be
 * topped up afterwards. The upper bound is the authorised amount and it is enforced in
 * `CapturePaymentFlow.resolveAmount` rather than here — this DTO has no idea what was
 * authorised, and a validator that pretends otherwise is a validator that lies.
 */

import { IsInt, IsOptional, Min } from 'class-validator';

import type { CapturePaymentIntentRequest, MinorUnits } from '@payzeno/contracts';

import { Money } from '../../common/validators/money.validator';

export class CapturePaymentIntentDto implements CapturePaymentIntentRequest {
  @IsOptional()
  @Money()
  @IsInt()
  @Min(1)
  amount_minor?: MinorUnits;
}
