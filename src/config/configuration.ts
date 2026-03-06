/**
 * The ONE env reader in payzeno-api.
 *
 * `.eslintrc.cjs` bans `process.env` everywhere else with an override for exactly this file.
 * Everything else in the repo takes `ApiConfig` by injection. If you are reading this because
 * you wanted an env var somewhere else: add it here, add it to ApiConfig, add it to
 * ConfigSchema, add it to .env.example. Four edits, one PR.
 */
import type {
  AcquirerConfig,
  ApiConfig,
  AuthConfig,
  AwsConfig,
  BillingLegacyConfig,
  DatabaseConfig,
  FlagsConfig,
  IdempotencyBackend,
  IdempotencyConfig,
  LedgerConfig,
  LimitsConfig,
  NodeEnv,
  RedisConfig,
  RuntimeConfig,
  VaultConfig,
  WebhooksConfig,
} from './api-config.type';
import { validateEnv, type ConfigSchema } from './config.schema';

/** Bumped by the release pipeline; surfaces on `GET /healthz`. */
const SERVICE_VERSION = process.env.npm_package_version ?? '1.34.0';

function database(env: ConfigSchema): DatabaseConfig {
  return {
    url: env.DATABASE_URL,
    poolSize: env.DATABASE_POOL_SIZE ?? 20,
    statementTimeoutMs: 15_000,
    ssl: env.NODE_ENV === 'production',
  };
}

function redis(env: ConfigSchema): RedisConfig {
  return { url: env.REDIS_URL, keyPrefix: 'pz:api:' };
}

function billingLegacy(env: ConfigSchema): BillingLegacyConfig {
  return {
    baseUrl: env.BILLING_LEGACY_BASE_URL,
    user: env.BILLING_LEGACY_USER,
    password: env.BILLING_LEGACY_PASSWORD,
    breakerErrorThresholdPercent: 50,
    breakerVolumeThreshold: 20,
    breakerResetTimeoutMs: 30_000,
  };
}

function aws(env: ConfigSchema): AwsConfig {
  return {
    region: env.AWS_REGION,
    endpointUrl: env.AWS_ENDPOINT_URL || undefined,
    snsPaymentsTopicArn: env.SNS_PAYMENTS_TOPIC_ARN,
    snsMerchantTopicArn: env.SNS_MERCHANT_TOPIC_ARN,
    sqsLedgerQueueUrl: env.SQS_LEDGER_QUEUE_URL,
    sqsApiWebhooksUrl: env.SQS_API_WEBHOOKS_URL,
    sqsConsoleNotificationsUrl: env.SQS_CONSOLE_NOTIFICATIONS_URL,
    sqsDlqUrl: env.SQS_DLQ_URL,
  };
}

export function loadConfiguration(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const env = validateEnv(source as Record<string, unknown>);

  return {
    runtime: runtime(env),
    database: database(env),
    redis: redis(env),
    ledger: ledger(env),
    billingLegacy: billingLegacy(env),
    vault: vault(env),
    acquirers: acquirers(env),
    auth: auth(env),
    webhooks: webhooks(env),
    aws: aws(env),
    idempotency: idempotency(env),
    limits: limits(env),
    flags: flags(env),
  };
}
