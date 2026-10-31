/**
 * `/v1/prices` and `/v1/subscriptions` bodies — `implements` the contracts types, shape only.
 * Whether the price is recurring and active, and whether the card is the customer's, are the
 * services' checks: they need the database.
 */
import { CURRENCIES, RECURRING_INTERVALS, SUBSCRIPTION_STATUSES } from '@payzeno/contracts';
import type {
  CancelSubscriptionRequest,
  CreatePriceRequest,
  CreateSubscriptionRequest,
  CurrencyCode,
  CustomerId,
  Metadata,
  MinorUnits,
  PaymentMethodId,
  PriceId,
  Recurring,
  RecurringInterval,
  SubscriptionStatus,
} from '@payzeno/contracts';
import { Type } from 'class-transformer';
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
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ListQueryDto } from '../../../common/pagination/list-query.dto';
import { IsPayzenoMetadata } from '../../../common/validators/metadata.validator';
import { Money } from '../../../common/validators/money.validator';
import { IsPayzenoId } from '../../../common/validators/payzeno-id.validator';
import { CUSTOMER_ID_PREFIX } from '../../../customers/customer.entity';
import { PAYMENT_METHOD_ID_PREFIX } from '../../../payment-methods/payment-method.entity';
import { PRICE_ID_PREFIX } from '../price.entity';

/** Same ceiling as `CreatePaymentIntentDto` — a price becomes an intent's amount every period. */
const MAX_AMOUNT_MINOR = 99_999_999;

export class RecurringDto implements Recurring {
  @IsIn(RECURRING_INTERVALS)
  interval!: RecurringInterval;

  @IsInt()
  @Min(1)
  @Max(12)
  interval_count!: number;
}

export class CreatePriceDto implements CreatePriceRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  product_name!: string;

  @Money()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_MINOR)
  unit_amount_minor!: MinorUnits;

  @IsIn(CURRENCIES)
  currency!: CurrencyCode;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurringDto)
  recurring?: RecurringDto;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}

export class CreateSubscriptionDto implements CreateSubscriptionRequest {
  @IsPayzenoId(CUSTOMER_ID_PREFIX)
  customer_id!: CustomerId;

  @IsPayzenoId(PRICE_ID_PREFIX)
  price_id!: PriceId;

  @IsOptional()
  @IsPayzenoId(PAYMENT_METHOD_ID_PREFIX)
  payment_method_id?: PaymentMethodId;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}

export class CancelSubscriptionDto implements CancelSubscriptionRequest {
  @IsOptional()
  @IsBoolean()
  at_period_end?: boolean;
}

/** `GET /v1/prices` query — filters on the DTO so the global pipe accepts them. */
export class PriceListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';
}

/** `GET /v1/subscriptions` query. */
export class SubscriptionListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsPayzenoId(CUSTOMER_ID_PREFIX)
  customer_id?: CustomerId;

  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: SubscriptionStatus;
}
