/**
 * `POST /v1/checkout/sessions` body — `implements CreateCheckoutSessionRequest`.
 *
 * Shape only. The cross-field rules (hosted needs `success_url`, embedded needs an origin-only
 * `allowed_origin`, line items sum to the amount, which fields each `mode` needs) and the
 * environment's URL scheme rule live in `CheckoutSessionsService`, which has the config and the
 * database and can name the field that is wrong.
 */
import { CHECKOUT_MODES, CHECKOUT_UI_MODES, CURRENCIES, SAVE_PAYMENT_METHOD_OPTIONS } from '@payzeno/contracts';
import type {
  CheckoutLineItem,
  CheckoutMode,
  CheckoutUiMode,
  CreateCheckoutSessionRequest,
  CurrencyCode,
  CustomerId,
  Metadata,
  MinorUnits,
  PriceId,
  SavePaymentMethodOption,
  SubscriptionId,
} from '@payzeno/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';


import { PRICE_ID_PREFIX } from '../../billing/recurring/price.entity';
import { SUBSCRIPTION_ID_PREFIX } from '../../billing/recurring/subscription.entity';
import { Redact } from '../../common/decorators/redact.decorator';
import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';
import { Money } from '../../common/validators/money.validator';
import { IsPayzenoId } from '../../common/validators/payzeno-id.validator';
import { CUSTOMER_ID_PREFIX } from '../../customers/customer.entity';

/** Same ceiling as `CreatePaymentIntentDto` — the session's amount becomes the intent's. */
const MAX_AMOUNT_MINOR = 99_999_999;
const URL_OPTS = { protocols: ['http', 'https'], require_protocol: true, require_tld: false };

export class CheckoutLineItemDto implements CheckoutLineItem {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;

  @Money()
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT_MINOR)
  unit_amount_minor!: MinorUnits;
}

@Redact('customer_email')
export class CreateCheckoutSessionDto implements CreateCheckoutSessionRequest {
  /** Required in `payment` mode; the service says so with the mode in hand. */
  @IsOptional()
  @Money()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_MINOR)
  amount_minor?: MinorUnits;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: CurrencyCode;

  @IsOptional()
  @IsIn(CHECKOUT_MODES)
  mode?: CheckoutMode;

  @IsOptional()
  @IsPayzenoId(PRICE_ID_PREFIX)
  price_id?: PriceId;

  @IsOptional()
  @IsPayzenoId(SUBSCRIPTION_ID_PREFIX)
  subscription_id?: SubscriptionId;

  @IsOptional()
  @IsPayzenoId(CUSTOMER_ID_PREFIX)
  customer_id?: CustomerId;

  @IsOptional()
  @IsIn(['if_required', 'always'])
  customer_creation?: 'if_required' | 'always';

  @IsOptional()
  @IsIn(SAVE_PAYMENT_METHOD_OPTIONS)
  save_payment_method?: SavePaymentMethodOption;

  @IsOptional()
  @IsBoolean()
  adaptive_pricing?: boolean;

  @IsOptional()
  @IsIn(CHECKOUT_UI_MODES)
  ui_mode?: CheckoutUiMode;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineItemDto)
  line_items?: CheckoutLineItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  customer_reference?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  customer_email?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  @MaxLength(2_048)
  success_url?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  @MaxLength(2_048)
  cancel_url?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  @MaxLength(255)
  allowed_origin?: string;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}
