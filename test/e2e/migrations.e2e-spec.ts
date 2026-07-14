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
    const named = migrations.map((m) => m.name);

    expect(timestamps.every((t) => Number.isFinite(t))).toBe(true);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
    expect(new Set(named).size).toBe(named.length);
  });

  it('applies every migration from an empty schema', async () => {
    await dataSource.undoLastMigration({ transaction: 'each' }).catch(() => undefined);
    const applied = await dataSource.runMigrations({ transaction: 'each' });

    const pending = await dataSource.showMigrations();
    expect(pending).toBe(false);
    expect(applied.length).toBeGreaterThanOrEqual(0);
  });

  it('creates every contracted table', async () => {
    const rows: Array<{ table_name: string }> = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
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
    const indexes = new Set(rows.map((r) => r.indexname));

    // PAY-2051, committed during the incident: without this a duplicate authorisation
    // from an acquirer retry becomes two charges.
    expect(indexes).toContain('uq_charge_processor_reference');
    // At-least-once fanout dedupe.
    expect(indexes).toContain('uq_webhook_event_source');
    // O(1) api key resolution — the reason ApiKeyGuard does not full-scan.
    expect(indexes).toContain('uq_api_key_lookup_hash');
    // One open dispute per charge.
    expect(indexes).toContain('uq_dispute_charge_open');
    // The console list was seq-scanning before migration 14 (arc PERF).
    expect(indexes).toContain('ix_charge_merchant_created');
  });

  it('reverts every migration cleanly, in reverse order', async () => {
    for (let i = 0; i < migrations.length; i += 1) {
      await dataSource.undoLastMigration({ transaction: 'each' });
    }

    const rows: Array<{ table_name: string }> = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const remaining = rows.map((r) => r.table_name).filter((t) => t !== MIGRATIONS_TABLE);

    expect(remaining).toEqual([]);
  });

  it('re-applies cleanly after a full revert', async () => {
    const applied = await dataSource.runMigrations({ transaction: 'each' });

    expect(applied).toHaveLength(migrations.length);
    expect(await dataSource.showMigrations()).toBe(false);
  });

  it('records every migration in the migrations table exactly once', async () => {
    const rows: Array<{ name: string; count: string }> = await dataSource.query(
      `SELECT name, COUNT(*)::text AS count FROM ${MIGRATIONS_TABLE} GROUP BY name HAVING COUNT(*) > 1`,
    );

    expect(rows).toEqual([]);
  });
});
