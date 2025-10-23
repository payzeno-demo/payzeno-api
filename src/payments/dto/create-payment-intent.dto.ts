/**
 * `POST /v1/payment_intents` body — `implements CreatePaymentIntentRequest`.
 *
 * `@Redact('payment_method_token')` is not because the token is card data — it is not, that is
 * the entire point of arc PCI — but because a token in a log line is a replayable credential
 * for one card until it is consumed.
 *
 * Note what is NOT here: no `card_number`, no `cvv`, no `exp_month`. Since migration 10 there
 * is nowhere in payzeno-api for those to go, and the browser tokenises directly against the
 * vault (docs/adr/0014-client-side-tokenisation.md).
 */

import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CAPTURE_METHODS, CURRENCIES } from '@payzeno/contracts';
import type {
  CaptureMethod,
  CreatePaymentIntentRequest,
  CurrencyCode,
  Metadata,
  MinorUnits,
  PaymentMethodToken,
} from '@payzeno/contracts';

import { Redact } from '../../common/decorators/redact.decorator';
import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';
import { Money } from '../../common/validators/money.validator';
import { IsStatementDescriptor } from '../../common/validators/statement-descriptor.validator';
import { IsVaultToken } from '../../common/validators/payzeno-id.validator';

/** Scheme limit on a single card transaction, in minor units. Nothing legitimate is bigger. */
const MAX_AMOUNT_MINOR = 99_999_999;

@Redact('payment_method_token')
export class CreatePaymentIntentDto implements CreatePaymentIntentRequest {
  @Money()
  @IsInt()
  @IsIn(CURRENCIES)
  currency: CurrencyCode;

  @IsOptional()
  @IsOptional()
  @MaxLength(128)
  customer_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  /** 22 chars, scheme-restricted character set — the validator knows the rules. */
  @IsOptional()
  /** Confirm in the same call. Ignored without a payment method, per the contract. */
  @IsOptional()
}
