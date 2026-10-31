/**
 * ApiConfig — the shape every other file in the repo receives instead of `process.env`.
 *
 * Three lists must stay in step and CI checks that they do:
 *   .env.example            the documented set
 *   ConfigSchema            the class-validator rules (config.schema.ts)
 *   ApiConfig               this type
 *
 * Adding a var without all three is a review rejection. See docs/runbooks/payzeno-api.md.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export type IdempotencyBackend = 'postgres' | 'redis';

export interface RuntimeConfig {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  otelExporterOtlpEndpoint: string;
  serviceName: string;
  serviceVersion: string;
}

export interface DatabaseConfig {
  url: string;
  poolSize: number;
  statementTimeoutMs: number;
  ssl: boolean;
}

export interface RedisConfig {
  url: string;
  keyPrefix: string;
}

export interface LedgerConfig {
  baseUrl: string;
  internalApiSecret: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  retries: number;
}

export interface BillingLegacyConfig {
  baseUrl: string;
  user: string;
  password: string;
  /** opossum: error threshold %, volume, reset window. */
  breakerErrorThresholdPercent: number;
  breakerVolumeThreshold: number;
  breakerResetTimeoutMs: number;
}

export interface VaultConfig {
  baseUrl: string;
  /** Handed to the browser by the console. Never used server-side. */
  publicUrl: string;
  apiKey: string;
}

/** The hosted payment page. */
export interface CheckoutConfig {
  /** Origin of pay.payzeno.com, no trailing slash. */
  publicUrl: string;
}

export interface AcquirerConfig {
  worldflowBaseUrl: string;
  worldflowApiKey: string;
  nordpayBaseUrl: string;
  nordpayApiKey: string;
  defaultAcquirer: 'worldflow' | 'nordpay';
}

export interface AuthConfig {
  sessionSecret: string;
  csrfCookieName: string;
  /** HMAC pepper for `api_key.lookup_hash`. Rotating it invalidates every live key. */
  apiKeyPepper: string;
  sessionTtlSeconds: number;
  csrfTtlSeconds: number;
}

export interface WebhooksConfig {
  signingKek: string;
  maxAttempts: number;
  retryWindowHours: number;
}

export interface AwsConfig {
  region: string;
  /** localstack in dev; undefined in prod so the SDK resolves the real endpoint. */
  endpointUrl: string | undefined;
  snsPaymentsTopicArn: string;
  snsMerchantTopicArn: string;
  sqsLedgerQueueUrl: string;
  sqsApiWebhooksUrl: string;
  sqsConsoleNotificationsUrl: string;
  sqsDlqUrl: string;
}

export interface IdempotencyConfig {
  backend: IdempotencyBackend;
  ttlHours: number;
  leaseSeconds: number;
}

export interface LimitsConfig {
  rateLimitDefaultRpm: number;
  refundWindowDays: number;
}

/** Raw `FLAG_*` values. Read only by EnvFeatureFlags. */
export interface FlagsConfig {
  ledgerOwnsInvoices: boolean;
  ledgerOwnsFees: boolean;
  redactPanInLogs: boolean;
}

export interface ApiConfig {
  runtime: RuntimeConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  ledger: LedgerConfig;
  billingLegacy: BillingLegacyConfig;
  vault: VaultConfig;
  checkout: CheckoutConfig;
  // --- platform-v2 identity config ---
  /** Outbound email (RFC platform-v2 §2). Read by EmailDeliveryJob's transport only. */
  email: {
    smtpHost: string;
    smtpPort: number;
    smtpUser: string | null;
    smtpPassword: string | null;
    from: string;
  };
  /** Public origins, no trailing slash. Emailed links are built from these and nothing else. */
  publicUrls: {
    console: string;
    admin: string | null;
  };
  kyc: {
    documentsBucket: string;
  };
  // --- end identity config ---
  // --- platform-v2 money config ---
  /** RFC platform-v2 §7. `fxProviderUrl` null = adaptive pricing switched off (fail closed). */
  money: {
    fxProviderUrl: string | null;
    fxCheckoutMarkupBps: number;
  };
  // --- end money config ---
  acquirers: AcquirerConfig;
  auth: AuthConfig;
  webhooks: WebhooksConfig;
  aws: AwsConfig;
  idempotency: IdempotencyConfig;
  limits: LimitsConfig;
  flags: FlagsConfig;
}

/** Nest DI token. `@Inject(API_CONFIG) private readonly config: ApiConfig`. */
export const API_CONFIG = Symbol('API_CONFIG');

/**
 * Value alias, so `ApiConfig` is both the type and the injection token. Modules constructed
 * by factory (`ApiModule`, `LedgerModule`) write `inject: [ApiConfig]`; modules using
 * property injection write `@Inject(API_CONFIG)`. Same symbol either way.
 */
export const ApiConfig = API_CONFIG;
