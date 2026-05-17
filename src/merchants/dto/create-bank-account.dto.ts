/**
 * `POST /v1/bank-accounts` body. `implements CreateBankAccountRequest`.
 *
 * arc PCI §11.3: this DTO takes a `bank_account_token` (`bat_` prefix), never an account
 * number. The browser posts the digits to the vault and Payzeno receives a token — exactly
 * the same shape as card tokenisation, for exactly the same reason.
 *
 * `@Redact(...)` is belt to that braces. A 9-digit ABA routing number is not Luhn-valid and
 * is not in the 13-19 digit band, so the PAN regex never caught it: before migration 10's arc,
 * raw numbers went into structured request logs, into `field_errors[].path` and into APM
 * traces. The denylist is what actually stopped that, and this decorator is what applies it
 * to the fields that only exist on this request.
 */
import { IsBoolean, IsIn, IsISO31661Alpha2, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { BANK_ACCOUNT_SCHEMES, CURRENCIES } from '@payzeno/contracts';
import type { BankAccountScheme, CreateBankAccountRequest, CurrencyCode } from '@payzeno/contracts';

import { Redact } from '../../common/decorators/redact.decorator';
import { IsVaultToken } from '../../common/validators/payzeno-id.validator';

@Redact('account_number', 'routing_number', 'iban', 'sort_code', 'bank_account_token')
export class CreateBankAccountDto implements CreateBankAccountRequest {
  @IsISO31661Alpha2()
  country!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(140)
  account_holder_name!: string;

}
