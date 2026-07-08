import { DataSource, QueryRunner } from 'typeorm';
import type { EntityManager } from 'typeorm';

import { dataSourceOptions } from 'src/migrations/data-source';

let shared: DataSource | null = null;

/**
 * One `DataSource` per jest worker. TypeORM connection pools are expensive and a
 * per-spec connection makes the e2e run flakier than the code it tests.
 */
export async function getTestDataSource(): Promise<DataSource> {
  if (shared && shared.isInitialized) {
    return shared;
  }
  shared = new DataSource({ ...dataSourceOptions, logging: false });
  await shared.initialize();
  return shared;
}

export async function closeTestDataSource(): Promise<void> {
  if (shared && shared.isInitialized) {
    await shared.destroy();
  }
  shared = null;
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back.
 *
 * This is the only isolation mechanism the suite has: `TRUNCATE` between tests would
 * serialise the whole run and `synchronize` is off (it is off in production too, so a
 * test that relied on it would be testing a schema nobody deploys).
 *
 * The rollback happens in `finally`, so a spec that throws still leaves the database
 * clean — the failure mode that used to leak `merchant` rows into the next file.
 */
export async function withTransactionalRollback<T>(
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const dataSource = await getTestDataSource();
  const runner: QueryRunner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    return await fn(runner.manager);
  } finally {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }
    await runner.release();
  }
}

/**
 * Applies every migration in `src/migrations/`, then reverts them all, then applies them
 * again. `test/e2e/migrations.e2e-spec.ts` asserts on it; nothing else should call it.
 */
export async function runMigrationsUpDownUp(): Promise<{ applied: number; reverted: number }> {
  const dataSource = await getTestDataSource();
  const applied = await dataSource.runMigrations({ transaction: 'each' });
  let reverted = 0;
  for (let i = 0; i < applied.length; i += 1) {
    await dataSource.undoLastMigration({ transaction: 'each' });
    reverted += 1;
  }
  await dataSource.runMigrations({ transaction: 'each' });
  return { applied: applied.length, reverted };
}

/** Row count helper — reads nicer than `.query()` in an assertion. */
export async function countRows(manager: EntityManager, table: string): Promise<number> {
  const rows: Array<{ count: string }> = await manager.query(
    `SELECT COUNT(*)::text AS count FROM "${table}"`,
  );
  return Number(rows[0]?.count ?? '0');
}

/** Truncates the tables an e2e file seeded outside a rollback boundary. */
export async function truncate(tables: string[]): Promise<void> {
  const dataSource = await getTestDataSource();
  if (tables.length === 0) {
    return;
  }
  const quoted = tables.map((t) => `"${t}"`).join(', ');
  await dataSource.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
}
