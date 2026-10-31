/**
 * Request DTOs for `/v1/signup` and `/v1/onboarding` (RFC platform-v2 §3). Each `implements`
 * its @payzeno/contracts type; the decorators are the validation, the contract is the shape.
 *
 * Profile fields accept `null` to clear a value — `PATCH` is "set these keys", and a merchant
 * who typed a website and then removed it must be able to say so. `@IsOptional()` lets `null`
 * through, which is exactly that.
 */
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  BUSINESS_TYPES,
  CURRENCIES,
  KYC_DOCUMENT_TYPES,
  type BusinessProfile,
  type BusinessType,
  type CurrencyCode,
  type KycDocumentType,
  type Representative,
  type SignupRequest,
  type UpdateOnboardingRequest,
  type UploadKycDocumentRequest,
  type VerifyEmailRequest,
} from '@payzeno/contracts';

/** Same rule as `AcceptInvitationDto` / `PasswordResetConfirmDto`: a password being chosen. */
const NEW_PASSWORD_MIN_LENGTH = 10;

/** 600 KB decoded is 819,200 base64 characters; the decoded size is re-checked in the service. */
export const KYC_DOCUMENT_MAX_BYTES = 600 * 1024;
const KYC_DOCUMENT_MAX_BASE64 = Math.ceil(KYC_DOCUMENT_MAX_BYTES / 3) * 4;

export const KYC_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

export class SignupRequestDto implements SignupRequest {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(NEW_PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(140)
  full_name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legal_name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  display_name!: string;

  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be an ISO 3166-1 alpha-2 code' })
  country!: string;

  @IsIn([...CURRENCIES])
  default_currency!: CurrencyCode;
}

export class VerifyEmailDto implements VerifyEmailRequest {
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  token!: string;
}

export class BusinessProfileDto implements Partial<BusinessProfile> {
  @IsOptional()
  @IsIn([...BUSINESS_TYPES])
  business_type?: BusinessType | null;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/\S+$/i, { message: 'website must be an http(s) URL' })
  @MaxLength(300)
  website?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  product_description?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  support_email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address_line1?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  registration_number?: string | null;
}

export class RepresentativeDto implements Partial<Representative> {
  @IsOptional()
  @IsString()
  @MaxLength(140)
  full_name?: string | null;

  /** Calendar date, `YYYY-MM-DD`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_of_birth must be YYYY-MM-DD' })
  date_of_birth?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;
}

export class UpdateOnboardingDto implements UpdateOnboardingRequest {
  @IsOptional()
  @ValidateNested()
  @Type(() => BusinessProfileDto)
  business_profile?: BusinessProfileDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RepresentativeDto)
  representative?: RepresentativeDto;
}

export class UploadKycDocumentDto implements UploadKycDocumentRequest {
  @IsIn([...KYC_DOCUMENT_TYPES])
  type!: KycDocumentType;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @IsIn([...KYC_CONTENT_TYPES])
  content_type!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(KYC_DOCUMENT_MAX_BASE64)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'content_base64 must be standard base64' })
  content_base64!: string;
}
