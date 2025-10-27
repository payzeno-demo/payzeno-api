/**
 * Global jest setup — referenced from `jest.config.ts::setupFilesAfterEach`.
 *
 * Three things happen here and nowhere else:
 *  1. `reflect-metadata` is imported before any decorated class is loaded. Without it
 *     `emitDecoratorMetadata` produces `undefined` design:paramtypes and every
 *     `Test.createTestingModule` in the suite fails with an unhelpful DI error.
 *  2. The handful of env vars `src/config/configuration.ts` treats as required are
 *     given deterministic test values. `configuration.ts` is the ONLY reader of
 *     `process.env` in the repo, so this is the only place a test may set one.
 *  3. A custom matcher, `toBeApiError`, so error-shape assertions read as one line.
 */
import 'reflect-metadata';

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://payzeno:payzeno@localhost:5432/payzeno_api_test',
  REDIS_URL: 'redis://localhost:6379/1',
  LEDGER_BASE_URL: 'http://ledger.test.internal',
  BILLING_LEGACY_BASE_URL: 'http://billing.test.internal',
  VAULT_BASE_URL: 'http://vault.test.internal',
  VAULT_API_KEY: 'vault_test_key',
  WORLDFLOW_BASE_URL: 'http://worldflow.test.internal:9100',
  NORDPAY_BASE_URL: 'http://nordpay.test.internal:9101',
  WORLDFLOW_API_KEY: 'wf_test_key',
  NORDPAY_API_KEY: 'np_test_key',
  API_KEY_PEPPER: 'test-pepper-0123456789abcdef',
  INTERNAL_API_SECRET: 'test-internal-secret',
  SESSION_SECRET: 'test-session-secret-0123456789ab',
  IDEMPOTENCY_BACKEND: 'postgres',
  REFUND_WINDOW_DAYS: '180',
  RATE_LIMIT_DEFAULT_RPM: '600',
  SQS_LEDGER_QUEUE_URL: 'http://sqs.test/payzeno-api-ledger',
  SQS_API_WEBHOOKS_URL: 'http://sqs.test/payzeno-api-webhooks',
  SQS_CONSOLE_NOTIFICATIONS_URL: 'http://sqs.test/payzeno-console-notifications',
  SQS_BILLING_QUEUE_URL: 'http://sqs.test/payzeno-api-billing',
  SQS_DLQ_URL: 'http://sqs.test/payzeno-dlq-monitor',
  AWS_REGION: 'eu-west-1',
  LOG_LEVEL: 'silent',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

expect.extend({
  /**
   * Asserts a value is the `ApiError` envelope from `@payzeno/contracts` and, optionally,
   * that its `error.code` matches. Keeps 40-odd filter/guard specs from each hand-rolling
   * the same three property assertions.
   */
  toBeApiError(received: unknown, expectedCode?: string) {
    const body = received as { error?: { code?: string; message?: string; request_id?: string } };
    const hasEnvelope =
      typeof body === 'object' &&
      body !== null &&
      typeof body.error === 'object' &&
      body.error !== null &&
      typeof body.error.code === 'string' &&
      typeof body.error.message === 'string' &&
      typeof body.error.request_id === 'string';

    if (!hasEnvelope) {
      return {
        pass: false,
        message: () => `expected ${JSON.stringify(received)} to be an ApiError envelope`,
      };
    }
    if (expectedCode !== undefined && body.error!.code !== expectedCode) {
      return {
        pass: false,
        message: () => `expected ApiError code ${expectedCode}, received ${body.error!.code}`,
      };
    }
    return { pass: true, message: () => 'expected value not to be an ApiError' };
  },
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeApiError(expectedCode?: string): R;
    }
  }
}

export {};
