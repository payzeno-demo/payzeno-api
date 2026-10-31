/**
 * `GET /v1/reviews` and `GET /v1/admin/reviews` query. The filters are declared here because
 * the global pipe validates the whole query against the class and refuses undeclared keys.
 * `merchant_id` only means something on the admin route; the merchant route is scoped by its
 * credential and ignores it.
 */
import { REVIEW_STATUSES } from '@payzeno/contracts';
import type { MerchantId, ReviewStatus } from '@payzeno/contracts';
import { IsIn, IsOptional } from 'class-validator';

import { ListQueryDto } from '../../common/pagination/list-query.dto';
import { IsPayzenoId } from '../../common/validators/payzeno-id.validator';

export class ReviewListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;

  @IsOptional()
  @IsPayzenoId('mch_')
  merchant_id?: MerchantId;
}
