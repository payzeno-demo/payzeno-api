/**
 * Query and body DTOs for `/v1/admin/*` (RFC platform-v2 §1). Each `implements` its
 * @payzeno/contracts type where one exists; the list queries extend `ListQueryDto`, so `limit`
 * and `cursor` behave exactly as on every merchant-facing list.
 */
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import {
  CURRENCIES,
  DISPUTE_STATUSES,
  EMAIL_TEMPLATES,
  MERCHANT_STATUSES,
  ONBOARDING_STATES,
  SUPPORT_TASK_KINDS,
  SUPPORT_TASK_STATUSES,
  type AdminMerchantListQuery,
  type AdminMerchantStatusRequest,
  type CurrencyCode,
  type DisputeStatus,
  type EmailTemplate,
  type MerchantId,
  type MerchantStatus,
  type OnboardingDecisionRequest,
  type OnboardingState,
  type ResolveSupportTaskRequest,
  type SupportTaskKind,
  type SupportTaskStatus,
} from '@payzeno/contracts';

import { ListQueryDto } from '../../common/pagination/list-query.dto';

const MERCHANT_ID = /^mch_[0-9A-HJKMNP-TV-Z]{26}$/;

export class AdminMerchantListQueryDto extends ListQueryDto implements AdminMerchantListQuery {
  @IsOptional()
  @IsIn([...MERCHANT_STATUSES])
  status?: MerchantStatus;

  @IsOptional()
  @IsIn([...ONBOARDING_STATES])
  onboarding_state?: OnboardingState;

  /** Merchant id, legal or display name, or a user's email. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class AdminDisputeListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn([...DISPUTE_STATUSES])
  status?: DisputeStatus;

  @IsOptional()
  @Matches(MERCHANT_ID)
  merchant_id?: MerchantId;
}

export class AdminSupportTaskListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn([...SUPPORT_TASK_STATUSES])
  status?: SupportTaskStatus;

  @IsOptional()
  @IsIn([...SUPPORT_TASK_KINDS])
  kind?: SupportTaskKind;

  @IsOptional()
  @Matches(MERCHANT_ID)
  merchant_id?: MerchantId;
}

/** `GET /v1/admin/emails?to=` — support's "did we email them?". */
export class AdminEmailLookupQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  to?: string;

  @IsOptional()
  @Matches(MERCHANT_ID)
  merchant_id?: MerchantId;

  @IsOptional()
  @IsIn([...EMAIL_TEMPLATES])
  template?: EmailTemplate;
}

export class SettlementBacklogQueryDto {
  @IsOptional()
  @IsIn([...CURRENCIES])
  currency?: CurrencyCode;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch_id?: string;
}

export class OnboardingDecisionDto implements OnboardingDecisionRequest {
  /** Required for `reject` and `request-info` (the service says so with a 422 on `message`). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}

export class AdminMerchantStatusDto implements AdminMerchantStatusRequest {
  @IsIn(['active', 'restricted', 'suspended'])
  status!: 'active' | 'restricted' | 'suspended';

  /** Lands in `staff_audit_log.reason`; the monthly review bounces a blank one. */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ResolveSupportTaskDto implements ResolveSupportTaskRequest {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
