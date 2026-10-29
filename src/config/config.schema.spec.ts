import { ConfigValidationError, validateEnv } from 'src/config/config.schema';

/**
 * Boot-time config validation. This is a crash-on-start guard, and it exists because of the
 * WEBHOOK_SIGNING_KEK incident: the var was absent in one task definition, the process booted
 * happily, and the first webhook of the day failed to sign forty minutes later — by which time
 * the deploy looked green and nobody was looking at the deploy any more.
 *
 * The two behaviours worth pinning:
 *   - every failure is reported, not just the first. A half-configured environment gets fixed
 *     in one pass instead of five deploys.
 *   - numeric and boolean vars are COERCED. `PORT` arriving as the string "3000" and being
 *     stored as a string is how `port + 1` became "30001" in the sidecar wiring.
 *
 * — apager. docs/runbooks/payzeno-api.md § "config drift".
 */
describe('validateEnv', () => {
  const VALID: Record<string, unknown> = {
    NODE_ENV: 'test',
    PORT: '8080',
    LOG_LEVEL: 'info',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
    DATABASE_URL: 'postgres://payzeno:payzeno@db:5432/payzeno_api',
    REDIS_URL: 'redis://redis:6379/0',
    LEDGER_BASE_URL: 'http://payzeno-ledger:8000',
    INTERNAL_API_SECRET: 'internal-secret',
    BILLING_LEGACY_BASE_URL: 'http://payzeno-billing-legacy:8090',
    BILLING_LEGACY_USER: 'payzeno-api',
    BILLING_LEGACY_PASSWORD: 'billing-password',
    VAULT_BASE_URL: 'http://payzeno-vault:8099',
    VAULT_PUBLIC_URL: 'https://vault.payzeno.com',
    VAULT_API_KEY: 'vault-key',
    CHECKOUT_PUBLIC_URL: 'https://pay.payzeno.com',
    SMTP_HOST: 'email-smtp.eu-west-1.amazonaws.com',
    SMTP_PORT: '587',
    EMAIL_FROM: 'Payzeno <no-reply@payzeno.com>',
    CONSOLE_PUBLIC_URL: 'https://console.payzeno.com',
    KYC_DOCUMENTS_BUCKET: 'payzeno-production-kyc-documents',
    WORLDFLOW_BASE_URL: 'http://payzeno-acquirer-sandbox:9100',
    WORLDFLOW_API_KEY: 'wf-key',
    NORDPAY_BASE_URL: 'http://payzeno-acquirer-sandbox:9101',
    NORDPAY_API_KEY: 'np-key',
    PROCESSOR_DEFAULT_ACQUIRER: 'worldflow',
    SESSION_SECRET: 'session-secret-that-is-at-least-32-bytes',
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

  function validate(overrides: Record<string, unknown> = {}): ReturnType<typeof validateEnv> {
    return validateEnv({ ...VALID, ...overrides });
  }

  function failuresFor(overrides: Record<string, unknown>): string[] {
    try {
      validate(overrides);
      return [];
    } catch (err) {
      return (err as ConfigValidationError).failures;
    }
  }

  /** Drops a key entirely, which is what an unset env var looks like. */
  function without(...keys: string[]): Record<string, unknown> {
    const bag = { ...VALID };
    for (const key of keys) delete bag[key];
    return bag;
  }

  it('accepts a complete environment', () => {
    expect(() => validate()).not.toThrow();
  });

  it('coerces numeric vars to numbers', () => {
    const env = validate();

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
    expect(env.WEBHOOK_MAX_ATTEMPTS).toBe(12);
    expect(env.IDEMPOTENCY_LEASE_SECONDS).toBe(30);
  });

  it('leaves flags as strings — asBool in configuration.ts owns that conversion', () => {
    expect(validate().FLAG_LEDGER_OWNS_FEES).toBe('true');
  });

  describe('missing variables', () => {
    it('throws ConfigValidationError', () => {
      expect(() => validateEnv(without('DATABASE_URL'))).toThrow(ConfigValidationError);
    });

    it('names the variable in the message so the fix is obvious from the crash log', () => {
      const err = (() => {
        try {
          validateEnv(without('WEBHOOK_SIGNING_KEK'));
          return null;
        } catch (e) {
          return e as ConfigValidationError;
        }
      })();

      expect(err?.message).toContain('WEBHOOK_SIGNING_KEK');
    });

    it('reports every failure at once, not just the first', () => {
      const err = (() => {
        try {
          validateEnv(without('DATABASE_URL', 'REDIS_URL', 'VAULT_API_KEY'));
          return null;
        } catch (e) {
          return e as ConfigValidationError;
        }
      })();

      expect(err?.failures).toHaveLength(3);
    });
  });

  describe('enumerated variables', () => {
    it('rejects an unknown NODE_ENV', () => {
      expect(failuresFor({ NODE_ENV: 'staging' })[0]).toContain('NODE_ENV');
    });

    it('rejects an unknown LOG_LEVEL', () => {
      expect(failuresFor({ LOG_LEVEL: 'trace' })[0]).toContain('LOG_LEVEL');
    });

    it('rejects an acquirer we have no adapter for', () => {
      expect(failuresFor({ PROCESSOR_DEFAULT_ACQUIRER: 'stripe' })[0]).toContain(
        'PROCESSOR_DEFAULT_ACQUIRER',
      );
    });

    it('accepts both idempotency backends', () => {
      expect(failuresFor({ IDEMPOTENCY_BACKEND: 'redis' })).toEqual([]);
      expect(failuresFor({ IDEMPOTENCY_BACKEND: 'postgres' })).toEqual([]);
    });

    it('rejects a third idempotency backend', () => {
      expect(failuresFor({ IDEMPOTENCY_BACKEND: 'dynamo' })).toHaveLength(1);
    });
  });

  describe('secrets with a minimum length', () => {
    it('rejects a short SESSION_SECRET with an explanation', () => {
      expect(failuresFor({ SESSION_SECRET: 'too-short' })[0]).toContain('at least 32 bytes');
    });

    it('rejects a short API_KEY_PEPPER', () => {
      expect(failuresFor({ API_KEY_PEPPER: 'abc' })[0]).toContain('API_KEY_PEPPER');
    });

    it('rejects a short INTERNAL_API_SECRET — it is the /internal/v1 credential', () => {
      expect(failuresFor({ INTERNAL_API_SECRET: 'x' })).toHaveLength(1);
    });
  });

  describe('bounded numbers', () => {
    it('rejects a port outside the TCP range', () => {
      expect(failuresFor({ PORT: '70000' })[0]).toContain('PORT');
      expect(failuresFor({ PORT: '0' })[0]).toContain('PORT');
    });

    it('rejects a non-numeric port', () => {
      expect(failuresFor({ PORT: 'eight-thousand' })).toHaveLength(1);
    });

    it('caps WEBHOOK_MAX_ATTEMPTS at 24', () => {
      // 24 attempts over the retry window is already three days of a merchant's endpoint
      // being hammered; more than that is a denial of service we are running for free.
      expect(failuresFor({ WEBHOOK_MAX_ATTEMPTS: '25' })).toHaveLength(1);
      expect(failuresFor({ WEBHOOK_MAX_ATTEMPTS: '24' })).toEqual([]);
    });

    it('caps REFUND_WINDOW_DAYS at two years', () => {
      expect(failuresFor({ REFUND_WINDOW_DAYS: '731' })).toHaveLength(1);
    });

    it('requires an idempotency lease of at least 5 seconds', () => {
      // A shorter lease expires while the acquirer call is still in flight, and the retry
      // that arrives next gets a fresh lease and charges the card twice.
      expect(failuresFor({ IDEMPOTENCY_LEASE_SECONDS: '2' })).toHaveLength(1);
    });

    it('requires a database pool of at least 2 when set', () => {
      expect(failuresFor({ DATABASE_POOL_SIZE: '1' })).toHaveLength(1);
      expect(failuresFor({ DATABASE_POOL_SIZE: '20' })).toEqual([]);
    });
  });

  describe('URLs', () => {
    it('requires a protocol', () => {
      expect(failuresFor({ LEDGER_BASE_URL: 'payzeno-ledger:8000' })).toHaveLength(1);
    });

    it('accepts a docker-compose hostname with no TLD', () => {
      // `http://payzeno-ledger:8000` is the real value in every environment but production.
      expect(failuresFor({ LEDGER_BASE_URL: 'http://payzeno-ledger:8000' })).toEqual([]);
    });

    it('rejects a non-http protocol', () => {
      expect(failuresFor({ LEDGER_BASE_URL: 'ftp://payzeno-ledger' })).toHaveLength(1);
    });
  });

  describe('optional variables', () => {
    it('allows AWS_ENDPOINT_URL to be absent — it is localstack-only', () => {
      expect(() => validateEnv(without('AWS_ENDPOINT_URL'))).not.toThrow();
    });

    it('allows DATABASE_POOL_SIZE to be absent', () => {
      expect(() => validateEnv(without('DATABASE_POOL_SIZE'))).not.toThrow();
    });
  });

  it('ignores unrelated variables rather than refusing to boot', () => {
    // ECS injects a dozen of its own. `forbidUnknownValues` is off for exactly this reason.
    expect(() => validate({ ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' })).not.toThrow();
  });
});
