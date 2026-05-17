/**
 * `POST /v1/api-keys` body. `implements CreateApiKeyRequest`.
 *
 * `scopes` is optional and defaults to every READ scope (`DEFAULT_SCOPES`). A merchant that
 * wants to move money has to ask for it — a key created by a developer poking the console
 * should not be able to issue refunds.
 *
 * ystackoverflow, PAY-2071, three rounds. Round one had `scopes: string[]`; osquash's comment
 * was "vocabulary" and a link to migration 19.
 */
import { ArrayMaxSize, ArrayUnique, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { API_KEY_MODES, API_KEY_SCOPES } from '@payzeno/contracts';
import type { ApiKeyMode, ApiKeyScope, CreateApiKeyRequest } from '@payzeno/contracts';

export class CreateApiKeyDto implements CreateApiKeyRequest {
  /** Merchant-chosen label. It appears in the console key list and in the audit log. */
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @ArrayUnique()
  @ArrayMaxSize(API_KEY_SCOPES.length)
  @IsIn([...API_KEY_SCOPES], { each: true })
  scopes?: ApiKeyScope[];
}
