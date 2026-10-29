/**
 * `/v1/customers` bodies — `implements` the contracts types, shape only. Whether a
 * `default_payment_method_id` is this customer's own attached card is `CustomersService`'s
 * check: it needs the database.
 */
import type { CreateCustomerRequest, Metadata, PaymentMethodId, UpdateCustomerRequest } from '@payzeno/contracts';
import { IsEmail, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { Redact } from '../../common/decorators/redact.decorator';
import { ListQueryDto } from '../../common/pagination/list-query.dto';
import { IsPayzenoMetadata } from '../../common/validators/metadata.validator';
import { IsPayzenoId } from '../../common/validators/payzeno-id.validator';
import { PAYMENT_METHOD_ID_PREFIX } from '../../payment-methods/payment-method.entity';

@Redact('email')
export class CreateCustomerDto implements CreateCustomerRequest {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}

@Redact('email')
export class UpdateCustomerDto implements UpdateCustomerRequest {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsPayzenoId(PAYMENT_METHOD_ID_PREFIX)
  default_payment_method_id?: PaymentMethodId;

  @IsOptional()
  @IsObject()
  @IsPayzenoMetadata()
  metadata?: Metadata;
}

/**
 * `GET /v1/customers` query. The filters live on the DTO, not as loose `@Query('x')` params:
 * the global pipe validates the whole query against this class and refuses any key it does
 * not declare.
 */
export class CustomerListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
