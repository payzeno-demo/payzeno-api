/**
 * Boot-time validation of the 42 environment variables in .env.example.
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

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsIn(['debug', 'info', 'warn', 'error'])
  LOG_LEVEL!: string;

  @IsUrl(URL_OPTS)
  OTEL_EXPORTER_OTLP_ENDPOINT!: string;

  // --- datastores -----------------------------------------------------------
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  DATABASE_POOL_SIZE?: number;

  // --- payzeno-ledger -------------------------------------------------------
  @IsUrl(URL_OPTS)
  LEDGER_BASE_URL!: string;

  @IsString()
  @MinLength(8)
  INTERNAL_API_SECRET!: string;

  // --- payzeno-billing-legacy ----------------------------------------------
  @IsUrl(URL_OPTS)
  BILLING_LEGACY_BASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  BILLING_LEGACY_USER!: string;

  @IsString()
  @IsNotEmpty()
  BILLING_LEGACY_PASSWORD!: string;

  // --- card vault -----------------------------------------------------------
  @IsUrl(URL_OPTS)
  VAULT_BASE_URL!: string;

  @IsUrl(URL_OPTS)
  VAULT_PUBLIC_URL!: string;

  @IsString()
  @IsNotEmpty()
  VAULT_API_KEY!: string;

  // --- hosted checkout ------------------------------------------------------
  /** Origin of pay.payzeno.com. Session URLs and the 3-D Secure return path hang off it. */
  @IsUrl(URL_OPTS)
  CHECKOUT_PUBLIC_URL!: string;

  // --- platform-v2 identity config (email, console url, kyc bucket) ---
  /** SMTP relay. Mailpit (`sim-mail:1025`) locally, SES's SMTP endpoint in AWS. */
  @IsString()
  @IsNotEmpty()
  SMTP_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT!: number;

  /** Both or neither. Mailpit takes anonymous submissions; SES does not. */
  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  /** RFC 5322 mailbox, e.g. `Payzeno <no-reply@payzeno.com>`. */
  @IsString()
  @IsNotEmpty()
  EMAIL_FROM!: string;

  /** Origin of console.payzeno.com. Every emailed link (verify, invite, reset) hangs off it. */
  @IsUrl(URL_OPTS)
  CONSOLE_PUBLIC_URL!: string;

  /** Origin of admin.payzeno.com. Optional: only staff-facing copy links to it. */
  @IsOptional()
  @IsUrl(URL_OPTS)
  ADMIN_PUBLIC_URL?: string;

  /** `payzeno-<env>-kyc-documents`. Private; staff read documents through the admin API. */
  @IsString()
  @IsNotEmpty()
  KYC_DOCUMENTS_BUCKET!: string;
  // --- end identity config ---

  // --- platform-v2 money config (fx provider, risk) ---
  /**
   * RFC platform-v2 §7. The FX rates vendor (`GET {url}/v1/rates?base=USD`); the simulated feed
   * locally. Optional: without it adaptive pricing offers nothing, which is the fail-closed answer.
   */
  @IsOptional()
  @IsUrl(URL_OPTS)
  FX_PROVIDER_URL?: string;

  /** Payzeno's markup on the provider mid-rate for checkout quotes. 200 = 2%. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_000)
  FX_CHECKOUT_MARKUP_BPS?: number;
  // --- end money config ---

  // --- acquirers ------------------------------------------------------------
  @IsUrl(URL_OPTS)
  WORLDFLOW_BASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  WORLDFLOW_API_KEY!: string;

  @IsUrl(URL_OPTS)
  NORDPAY_BASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  NORDPAY_API_KEY!: string;

  @IsIn(['worldflow', 'nordpay'])
  PROCESSOR_DEFAULT_ACQUIRER!: string;

  // --- auth -----------------------------------------------------------------
  @IsString()
  @MinLength(32, { message: 'SESSION_SECRET must be at least 32 bytes of entropy' })
  SESSION_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  CSRF_COOKIE_NAME!: string;

  @IsString()
  @MinLength(8)
  API_KEY_PEPPER!: string;

  // --- webhooks -------------------------------------------------------------
  @IsString()
  @IsNotEmpty()
  WEBHOOK_SIGNING_KEK!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  WEBHOOK_MAX_ATTEMPTS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  WEBHOOK_RETRY_WINDOW_HOURS!: number;

  // --- bus ------------------------------------------------------------------
  @IsString()
  @IsNotEmpty()
  AWS_REGION!: string;

  @IsOptional()
  @IsString()
  AWS_ENDPOINT_URL?: string;

  @IsString()
  @IsNotEmpty()
  SNS_PAYMENTS_TOPIC_ARN!: string;

  @IsString()
  @IsNotEmpty()
  SNS_MERCHANT_TOPIC_ARN!: string;

  @IsString()
  @IsNotEmpty()
  SQS_LEDGER_QUEUE_URL!: string;

  @IsString()
  @IsNotEmpty()
  SQS_API_WEBHOOKS_URL!: string;

  @IsString()
  @IsNotEmpty()
  SQS_CONSOLE_NOTIFICATIONS_URL!: string;

  @IsString()
  @IsNotEmpty()
  SQS_DLQ_URL!: string;

  // --- idempotency ----------------------------------------------------------
  @IsIn(['postgres', 'redis'])
  IDEMPOTENCY_BACKEND!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  IDEMPOTENCY_TTL_HOURS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(5)
  IDEMPOTENCY_LEASE_SECONDS!: number;

  // --- limits ---------------------------------------------------------------
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_DEFAULT_RPM!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  REFUND_WINDOW_DAYS!: number;

  // --- flags ----------------------------------------------------------------
  @IsBooleanString()
  FLAG_LEDGER_OWNS_INVOICES!: string;

  @IsBooleanString()
  FLAG_LEDGER_OWNS_FEES!: string;

  @IsBooleanString()
  FLAG_REDACT_PAN_IN_LOGS!: string;
}

export class ConfigValidationError extends Error {
  constructor(readonly failures: string[]) {
    super(`payzeno-api config is invalid:\n  - ${failures.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates a raw env bag and returns the coerced schema instance.
 * Throws `ConfigValidationError` listing every failure, not just the first — a half-configured
 * environment should be fixed in one pass.
 */
export function validateEnv(raw: Record<string, unknown>): ConfigSchema {
  const instance = plainToInstance(ConfigSchema, raw, { enableImplicitConversion: false });
  const errors = validateSync(instance, {
    skipMissingProperties: false,
    whitelist: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const failures = errors.map((e) => {
      const constraints = e.constraints ? Object.values(e.constraints) : ['is invalid'];
      return `${e.property}: ${constraints.join('; ')}`;
    });
    throw new ConfigValidationError(failures);
  }

  return instance;
}
