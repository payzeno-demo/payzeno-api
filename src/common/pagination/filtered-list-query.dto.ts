/**
 * List queries that carry filters beyond paging.
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted`, and a controller that takes
 * `@Query() query: ListQueryDto` validates the WHOLE query string against that class. A
 * filter read separately with `@Query('status')` was therefore "not whitelisted" and every
 * filtered list answered 422 "property status should not exist" — the console's status
 * filters, the refunds-by-charge lookup, the webhook-event filters. Declaring the filters on a
 * per-route subclass is what makes them allowed. Values stay strings here, as the handlers
 * already treat them; tightening any of them to an enum is a behaviour change for its owner.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { ListQueryDto } from './list-query.dto';

const FILTER_MAX = 128;

export class StatusListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  status?: string;
}

export class PaymentIntentListQueryDto extends StatusListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  customer_reference?: string;
}

export class ChargeListQueryDto extends StatusListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  payment_intent_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  settlement_batch_id?: string;
}

export class RefundListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  charge_id?: string;
}

export class WebhookEventListQueryDto extends StatusListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(FILTER_MAX)
  type?: string;
}
