/**
 * `POST /v1/payment_intents/:id/cancel` body — `implements CancelPaymentIntentRequest`.
 *
 * The reason is optional and defaults to `requested_by_customer` in the flow. It is not
 * cosmetic: `fraudulent` and `duplicate` both feed the merchant's risk profile, and
 * `expired` is the value `ChargeExpiryJob` writes when it cancels an intent whose
 * authorisation aged out — which is why the enum includes a value no human ever sends.
 */

import { IsIn, IsOptional } from 'class-validator';

import { CANCELLATION_REASONS } from '@payzeno/contracts';
import type { CancellationReason, CancelPaymentIntentRequest } from '@payzeno/contracts';

export class CancelPaymentIntentDto implements CancelPaymentIntentRequest {
  @IsOptional()
  @IsIn(CANCELLATION_REASONS)
  cancellation_reason?: CancellationReason;
}
