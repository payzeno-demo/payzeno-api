import { loadConfiguration } from 'src/config/configuration';

/**
 * The ONE env reader in the repo (`.eslintrc.cjs` bans `process.env` everywhere else).
 *
 * `loadConfiguration` takes its source as an argument precisely so this spec can drive it
 * without mutating the real environment — which matters, because a config spec that
 * writes to `process.env` leaks into every other file in the worker.
 */
describe('loadConfiguration', () => {
  const REQUIRED: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://payzeno:payzeno@db:5432/payzeno_api',
    REDIS_URL: 'redis://redis:6379/0',
    LEDGER_BASE_URL: 'http://payzeno-ledger:8000',
    INTERNAL_API_SECRET: 'internal-secret',
    BILLING_LEGACY_BASE_URL: 'http://payzeno-billing-legacy:8080',
    BILLING_LEGACY_USER: 'payzeno-api',
    BILLING_LEGACY_PASSWORD: 'billing-password',
    VAULT_BASE_URL: 'http://payzeno-vault:8200',
    VAULT_PUBLIC_URL: 'https://vault.payzeno.com',
    VAULT_API_KEY: 'vault-key',
    CHECKOUT_PUBLIC_URL: 'https://pay.payzeno.com',
    SMTP_HOST: 'email-smtp.eu-west-1.amazonaws.com',
    SMTP_PORT: '587',
    EMAIL_FROM: 'Payzeno <no-reply@payzeno.com>',
    CONSOLE_PUBLIC_URL: 'https://console.payzeno.com',
    KYC_DOCUMENTS_BUCKET: 'payzeno-production-kyc-documents',
    WORLDFLOW_BASE_URL: 'http://worldflow:9100',
    WORLDFLOW_API_KEY: 'wf-key',
    NORDPAY_BASE_URL: 'http://nordpay:9101',
    NORDPAY_API_KEY: 'np-key',
    PROCESSOR_DEFAULT_ACQUIRER: 'worldflow',
    SESSION_SECRET: 'session-secret-that-is-long-enough',
    CSRF_COOKIE_NAME: 'pz_csrf',
    API_KEY_PEPPER: 'api-key-pepper-value',
    WEBHOOK_SIGNING_KEK: 'arn:aws:kms:eu-west-1:1:key/abc',
    WEBHOOK_MAX_ATTEMPTS: '12',
    WEBHOOK_RETRY_WINDOW_HOURS: '72',
    AWS_REGION: 'eu-west-1',
    SNS_PAYMENTS_TOPIC_ARN: 'arn:aws:sns:eu-west-1:1:payzeno-payments-events',
    SNS_MERCHANT_TOPIC_ARN: 'arn:aws:sns:eu-west-1:1:payzeno-merchant-events',
    SQS_LEDGER_QUEUE_URL: 'http://sqs/payzeno-api-ledger',
    SQS_API_WEBHOOKS_URL: 'http://sqs/payzeno-api-webhooks',
    SQS_CONSOLE_NOTIFICATIONS_URL: 'http://sqs/payzeno-console-notifications',
    SQS_DLQ_URL: 'http://sqs/payzeno-dlq-monitor',
    IDEMPOTENCY_BACKEND: 'postgres',
    IDEMPOTENCY_TTL_HOURS: '24',
    IDEMPOTENCY_LEASE_SECONDS: '30',
    RATE_LIMIT_DEFAULT_RPM: '600',
    REFUND_WINDOW_DAYS: '180',
    FLAG_LEDGER_OWNS_INVOICES: 'false',
    FLAG_LEDGER_OWNS_FEES: 'true',
    FLAG_REDACT_PAN_IN_LOGS: 'true',
  };

  function load(overrides: NodeJS.ProcessEnv = {}) {
    return loadConfiguration({ ...REQUIRED, ...overrides });
  }

  it('loads a complete environment', () => {
    expect(() => load()).not.toThrow();
  });

  it('does not read the ambient process.env when a source is supplied', () => {
    const config = load({ PORT: '8081' });

    expect(config.runtime.port).toBe(8081);
  });

  it('coerces numeric vars to numbers, not strings', () => {
    const config = load();

    expect(typeof config.runtime.port).toBe('number');
    expect(typeof config.idempotency.ttlHours).toBe('number');
    expect(typeof config.webhooks.maxAttempts).toBe('number');
    expect(typeof config.limits.rateLimitDefaultRpm).toBe('number');
  });

  it('coerces flag vars to booleans', () => {
    const config = load();

    expect(config.flags.ledgerOwnsInvoices).toBe(false);
    expect(config.flags.ledgerOwnsFees).toBe(true);
    expect(config.flags.redactPanInLogs).toBe(true);
  });

  it('accepts 1 as well as "true" for a flag', () => {
    expect(load({ FLAG_LEDGER_OWNS_INVOICES: '1' }).flags.ledgerOwnsInvoices).toBe(true);
  });

  it('treats anything else as false rather than truthy', () => {
    expect(load({ FLAG_LEDGER_OWNS_INVOICES: 'yes' }).flags.ledgerOwnsInvoices).toBe(false);
    expect(load({ FLAG_LEDGER_OWNS_INVOICES: '' }).flags.ledgerOwnsInvoices).toBe(false);
  });

  it('groups config into the sections ApiConfig declares', () => {
    const config = load();

    for (const section of [
      'runtime',
      'database',
      'redis',
      'ledger',
      'billingLegacy',
      'vault',
      'acquirers',
      'auth',
      'webhooks',
      'aws',
      'idempotency',
      'limits',
      'flags',
    ]) {
      expect(config).toHaveProperty(section);
    }
  });

  it('applies the ledger timeouts of api-surface.md §11', () => {
    const config = load();

    expect(config.ledger.connectTimeoutMs).toBe(2_000);
    expect(config.ledger.readTimeoutMs).toBe(10_000);
    expect(config.ledger.retries).toBe(2);
  });

  it('applies the billing breaker thresholds of api-surface.md §13', () => {
    const config = load();

    expect(config.billingLegacy.breakerErrorThresholdPercent).toBe(50);
    expect(config.billingLegacy.breakerVolumeThreshold).toBe(20);
    expect(config.billingLegacy.breakerResetTimeoutMs).toBe(30_000);
  });

  it('enables SSL to the database only in production', () => {
    expect(load({ NODE_ENV: 'production' }).database.ssl).toBe(true);
    expect(load({ NODE_ENV: 'test' }).database.ssl).toBe(false);
  });

  it('namespaces every redis key', () => {
    expect(load().redis.keyPrefix).toBe('pz:api:');
  });

  it('reports a service name and version for /healthz', () => {
    const config = load();

    expect(config.runtime.serviceName).toBe('payzeno-api');
    expect(config.runtime.serviceVersion).toEqual(expect.any(String));
  });

  it('treats an empty AWS_ENDPOINT_URL as absent, so the SDK uses the real endpoint', () => {
    expect(load({ AWS_ENDPOINT_URL: '' }).aws.endpointUrl).toBeUndefined();
    expect(load({ AWS_ENDPOINT_URL: 'http://localstack:4566' }).aws.endpointUrl).toBe(
      'http://localstack:4566',
    );
  });

  describe('validation', () => {
    it.each([
      'DATABASE_URL',
      'REDIS_URL',
      'LEDGER_BASE_URL',
      'INTERNAL_API_SECRET',
      'SESSION_SECRET',
      'API_KEY_PEPPER',
      'VAULT_API_KEY',
    ])('refuses to boot without %s', (key) => {
      const env = { ...REQUIRED };
      delete env[key];

      // Failing at boot is the point. A missing pepper that surfaces as a 401 storm two
      // hours after deploy is much worse than a container that will not start.
      expect(() => loadConfiguration(env)).toThrow();
    });

    it('refuses an unknown acquirer as the default', () => {
      expect(() => load({ PROCESSOR_DEFAULT_ACQUIRER: 'stripe' })).toThrow();
    });

    it('refuses an unknown idempotency backend', () => {
      expect(() => load({ IDEMPOTENCY_BACKEND: 'memcached' })).toThrow();
    });

    it('refuses a non-numeric port', () => {
      expect(() => load({ PORT: 'eighty' })).toThrow();
    });
  });
});
