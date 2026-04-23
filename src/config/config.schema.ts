/**
 * Boot-time validation of the 41 environment variables in .env.example.
 *
 * class-validator over a plain class, run once by `loadConfiguration()`. The process exits
 * non-zero on the first failure — a missing var is a crash-on-start, not a 500 an hour later
 * when the first request happens to touch that code path. apager wrote this after the
 * WEBHOOK_SIGNING_KEK incident; the runbook section is "config drift".
 */
import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { Type } from 'class-transformer';

const URL_OPTS = { require_tld: false, protocols: ['http', 'https'], require_protocol: true };

export class ConfigSchema {
  // --- runtime --------------------------------------------------------------
  @IsIn(['development', 'test', 'production'])
  NODE_ENV!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsUrl(URL_OPTS)
  OTEL_EXPORTER_OTLP_ENDPOINT!: string;

  @IsNotEmpty()
  REDIS_URL!: string;

  @IsOptional()
  @Type(() => Number)
  @Min(2)
  DATABASE_POOL_SIZE?: number;

  @IsString()
  @IsString()
  @IsNotEmpty()
  BILLING_LEGACY_USER!: string;

  @IsNotEmpty()
  BILLING_LEGACY_PASSWORD!: string;

  // --- card vault -----------------------------------------------------------
  @IsUrl(URL_OPTS)
  VAULT_BASE_URL!: string;

  @IsNotEmpty()
  VAULT_API_KEY!: string;

  @IsString()
  @IsNotEmpty()
  NORDPAY_API_KEY!: string;

  @IsIn(['worldflow', 'nordpay'])
  PROCESSOR_DEFAULT_ACQUIRER!: string;

  // --- auth -----------------------------------------------------------------
  @IsString()
  @IsString()
  @IsNotEmpty()
  CSRF_COOKIE_NAME!: string;

  @MinLength(8)
  API_KEY_PEPPER!: string;

  @IsNotEmpty()
  WEBHOOK_SIGNING_KEK!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  WEBHOOK_RETRY_WINDOW_HOURS!: number;

  @IsString()
  @IsString()
  @IsString()
  @IsNotEmpty()
  SQS_API_WEBHOOKS_URL!: string;

  @IsString()
  @IsNotEmpty()
  SQS_CONSOLE_NOTIFICATIONS_URL!: string;

  @IsString()
  @IsInt()
  @IsInt()
  @Min(5)
  IDEMPOTENCY_LEASE_SECONDS!: number;

  // --- limits ---------------------------------------------------------------
  @Type(() => Number)
  @Min(1)
  RATE_LIMIT_DEFAULT_RPM!: number;

  @Type(() => Number)
  @Min(1)
  @Max(730)
  REFUND_WINDOW_DAYS!: number;

  @IsBooleanString()
  FLAG_LEDGER_OWNS_FEES!: string;

  @IsBooleanString()
  FLAG_REDACT_PAN_IN_LOGS!: string;
}

export class ConfigValidationError extends Error {
}
