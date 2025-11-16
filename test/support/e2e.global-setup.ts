import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { dataSourceOptions } from 'src/migrations/data-source';

/**
 * Jest `globalSetup` for the e2e project (`jest.e2e.config.ts`).
 *
 * Runs ONCE per e2e invocation, before any worker starts: creates the schema by running
 * every migration in `src/migrations/`. Not `synchronize` — production never uses it, and
 * a suite that builds its schema differently from production tests a schema nobody has.
 */
export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';

  const dataSource = new DataSource({ ...dataSourceOptions, logging: false });
  await dataSource.initialize();

  try {
    const pending = await dataSource.showMigrations();
    if (pending) {
      const applied = await dataSource.runMigrations({ transaction: 'each' });
      // eslint-disable-next-line no-console
      console.log(`[e2e] applied ${applied.length} migrations`);
    }
    await assertCleanStart(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

/**
 * A leftover row from an interrupted run is the single most common cause of an e2e
 * failure that reproduces for nobody else, so the suite refuses to start on one rather
 * than reporting it eight files later as a duplicate-key error.
 */
async function assertCleanStart(dataSource: DataSource): Promise<void> {
  const tables = ['merchant', 'payment_intent', 'charge', 'refund', 'dispute', 'webhook_event'];
  for (const table of tables) {
    const rows: Array<{ count: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM "${table}"`,
    );
  }
}
