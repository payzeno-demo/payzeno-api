/**
 * `POST /v1/merchants` body. `implements CreateMerchantRequest` — it does not restate it.
 *
 * The MCC rule is the only interesting validation here and it is not cosmetic: 3000-3999,
 * 7011 and 7512 are the travel / lodging / car-rental set the schemes grant 30-day
 * authorisation validity, and they are exactly the merchants `capture_at_settlement` targets.
 * A typo'd MCC on onboarding produces a merchant whose auths expire at 7 days and whose
 * captures then fail three weeks later, in the ledger, at settlement time.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CURRENCIES, PAYOUT_SCHEDULES } from '@payzeno/contracts';
import type {
  CreateMerchantRequest,
  CurrencyCode,
  Metadata,
  PayoutSchedule,
} from '@payzeno/contracts';

import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';

export class CreateMerchantDto implements CreateMerchantRequest {
  @IsString()
  @MinLength(2)
  @IsOptional()
}
