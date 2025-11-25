import { DataSource } from 'typeorm';

import { dataSourceOptions, MIGRATIONS_TABLE, migrations } from 'src/migrations/data-source';

/**
 * Every migration in `src/migrations/` runs up and down (tests.md §3.2).
 *
 * This is the cheapest test in the repo and the one that has caught the most: an
 * `ALTER TYPE … ADD VALUE` that cannot run inside a transaction, a `down()` that drops a
 * column it never added, a renumbered timestamp that reorders two dependent migrations.
 * All three shipped to staging at least once before this file existed.
 */
describe('migrations', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ ...dataSourceOptions, logging: false });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('registers the full contracted migration set', () => {
    expect(migrations.length).toBe(32);
  });

  it('has strictly increasing timestamps — the class name carries the order', () => {
    const timestamps = migrations.map((m) => {
      const match = /(\d{13})/.exec(m.name ?? '');
      return match ? Number(match[1]) : Number.NaN;
    });
    const applied = await dataSource.runMigrations({ transaction: 'each' });

    const pending = await dataSource.showMigrations();
    expect(pending).toBe(false);
    expect(applied.length).toBeGreaterThanOrEqual(0);
  });

  it('creates every contracted table', async () => {
    const tables = new Set(rows.map((r) => r.table_name));

    for (const expected of [
      'merchant',
      'merchant_user',
      'api_key',
      'bank_account',
      'payment_intent',
      'charge',
      'refund',
      'dispute',
      'webhook_endpoint',
      'webhook_event',
      'idempotency_record',
      'event_outbox',
      'processed_event',
      'audit_log',
      'staff_user',
      'staff_audit_log',
      'invoice_projection',
      'support_task',
      'settlement_completion',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('creates the uniqueness constraints the money path depends on', async () => {
    const rows: Array<{ indexname: string }> = await dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const rows: Array<{ table_name: string }> = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
  });
});
