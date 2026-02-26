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
  @MaxLength(100)
  display_name!: string;

  @IsISO31661Alpha2()
  country!: string;

  @IsIn([...CURRENCIES])
  default_currency!: CurrencyCode;

  /** Four digits, as a string. `'0742'` is a real MCC and `742` is not the same value. */
  @Matches(/^\d{4}$/, { message: 'mcc must be exactly four digits' })
  mcc!: string;

  @IsIn([...PAYOUT_SCHEDULES])
  payout_schedule?: PayoutSchedule;

  /**
   * `@IsPayzenoMetadata()` rejects PAN-shaped values (arc PCI, domain-model.md §11.4). A
   * merchant putting a card number in `metadata.note` is how cardholder data gets into a
   * table that is explicitly out of scope.
   */
  @IsOptional()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}
