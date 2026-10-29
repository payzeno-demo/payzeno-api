/** `POST /v1/admin/reviews/:id/approve|decline` body — `implements ReviewDecisionRequest`. */
import type { ReviewDecisionRequest } from '@payzeno/contracts';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewDecisionDto implements ReviewDecisionRequest {
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  note?: string;
}
