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

