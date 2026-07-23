import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { dataSourceOptions } from 'src/migrations/data-source';

/**
 * Jest `globalTeardown` for the e2e project.
 *
 * Leaves the schema in place (re-running migrations on every `pnpm test:e2e` costs ~9s
 * locally) but clears the data every suite wrote, so the next run starts from the same
 * state whether or not the previous one crashed.
 *
 * `KEEP_E2E_DATA=1` skips the truncate — the flag `apager` added the morning after an
 * e2e failure that could not be reproduced because teardown had already deleted the row.
 */
const TABLES_IN_DEPENDENCY_ORDER = [
  'webhook_event',
  'webhook_endpoint',
  'event_outbox',
  'processed_event',
  'settlement_completion',
  'support_task',
  'audit_log',
  'staff_audit_log',
  'idempotency_record',
  'invoice_projection',
  'refund',
  'dispute',
  'charge',
  'payment_intent',
  'bank_account',
  'api_key',
  'merchant_user',
  'merchant',
];

export default async function globalTeardown(): Promise<void> {
  if (process.env.KEEP_E2E_DATA === '1') {
    // eslint-disable-next-line no-console
    console.log('[e2e] KEEP_E2E_DATA=1 — leaving data in place');
    return;
  }

  const dataSource = new DataSource({ ...dataSourceOptions, logging: false });
  await dataSource.initialize();
  try {
    const quoted = TABLES_IN_DEPENDENCY_ORDER.map((t) => `"${t}"`).join(', ');
    await dataSource.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
  } finally {
    await dataSource.destroy();
  }
}
