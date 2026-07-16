/**
 * `PATCH /v1/merchants/:merchantId` body. `implements UpdateMerchantRequest`.
 *
 * Eight of these fields are STAFF-ONLY (`STAFF_ONLY_MERCHANT_FIELDS` in merchants.service.ts).
 * class-validator cannot express "only if the principal is staff", so the check lives in
 * `MerchantsController.update`, which has the principal — and a merchant-session PATCH
 * carrying any of them is 403, not a silent drop. A silent drop is worse: the console shows
 * the merchant a reserve percentage they set and we ignored.
 *
 * `capture_at_settlement` is the one that matters most. It is the deferred-capture switch,
 * it propagates to the ledger only through `merchant.updated`, and it is the eleven-merchant
 * blast radius of arc INC.
 */
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { PAYOUT_SCHEDULES, RISK_TIERS } from '@payzeno/contracts';
import type {
  BasisPoints,
  Metadata,
  MinorUnits,
  PayoutSchedule,
  RiskTier,
  UpdateMerchantRequest,
} from '@payzeno/contracts';

import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';
import { Money } from '../../common/validators/money.validator';
import { IsStatementDescriptor } from '../../common/validators/statement-descriptor.validator';

export class UpdateMerchantDto implements UpdateMerchantRequest {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @IsOptional()
  /** ≤ 22 chars, `[A-Za-z0-9 .,\-]` only. It is what the cardholder sees on their statement. */
  @IsOptional()
  @IsStatementDescriptor()
  statement_descriptor?: string;

  // ---- staff-only from here down. MerchantsController enforces it. -----------------

  @IsOptional()
  /** 10000 bps = 100%. A reserve above that would hold more than the merchant is owed. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  reserve_hold_days?: number;

  /** T+0 to T+30. `high` risk merchants sit at 7. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  platform_fee_bps?: BasisPoints;

  /**
   * `allowZero` and `skipCeiling`: a merchant on pure-bps pricing has a fixed component of 0,
   * and the scheme ceiling is about a single transaction, not a per-transaction fee.
   */
  @Type(() => Number)
  @Money({ allowZero: true, skipCeiling: true })
  @IsInt()
  @IsOptional()
  @Money({ allowZero: true, skipCeiling: true })
  @IsInt()
  @IsOptional()
  @IsBoolean()
  capture_at_settlement?: boolean;

  @IsOptional()
  @Type(() => Object)
  @IsPayzenoMetadata()
  metadata?: Metadata;
}

/** `POST /v1/merchants/:merchantId/status` body. Not a contracts type — the route's own shape. */
export class ChangeMerchantStatusDto {
  @IsIn(['pending_review', 'active', 'restricted', 'suspended', 'rejected', 'closed'])
  status!: string;

  /** Required, and it lands in `staff_audit_log.reason`. "because" is a valid answer; none is not. */
  @IsString()
  @MaxLength(500)
  reason!: string;
}
