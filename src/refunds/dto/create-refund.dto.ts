/**
 * `POST /v1/refunds` body.
 *
 * `implements CreateRefundRequest` — the DTO adds validation to the contracts shape and never
 * restates it. A DTO that redeclares a `@payzeno/contracts` type is a review rejection
 * (interfaces.md §2.5) because the two copies drift and the console codes against the wrong one.
 */

import { IsIn, IsInt, IsObject, IsOptional, Min } from 'class-validator';

import { REFUND_REASONS } from '@payzeno/contracts';
import type { ChargeId, CreateRefundRequest, Metadata, MinorUnits, RefundReason } from '@payzeno/contracts';

import { Money } from '../../common/validators/money.validator';
import { IsPayzenoId } from '../../common/validators/payzeno-id.validator';
import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';

export class CreateRefundDto implements CreateRefundRequest {
  @IsPayzenoId('ch_')
  charge_id: ChargeId;

  /**
   * Omitted means "everything still refundable". Deliberately not defaulted here: the
   * remaining amount is only knowable under the charge's row lock, so RefundPolicyService
   * resolves it and this stays `undefined`.
   */
  @IsOptional()
  @Money()
  @IsInt()
  @Min(1)
  amount_minor?: MinorUnits;

  @IsOptional()
  @IsIn(REFUND_REASONS)
  reason?: RefundReason;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}
