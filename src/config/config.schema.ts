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
  @Max(65535)
  PORT!: number;

  @IsUrl(URL_OPTS)
  OTEL_EXPORTER_OTLP_ENDPOINT!: string;

  @Type(() => Number)
  @IsNotEmpty()
  BILLING_LEGACY_PASSWORD!: string;

  @IsNotEmpty()
  VAULT_API_KEY!: string;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  SQS_API_WEBHOOKS_URL!: string;

  @IsString()
  @IsNotEmpty()
  SQS_CONSOLE_NOTIFICATIONS_URL!: string;

  @IsString()
  @IsInt()
  @Min(5)
  IDEMPOTENCY_LEASE_SECONDS!: number;

  @IsBooleanString()
  FLAG_LEDGER_OWNS_FEES!: string;

  @IsBooleanString()
  FLAG_REDACT_PAN_IN_LOGS!: string;
}

export class ConfigValidationError extends Error {
}
