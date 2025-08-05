/**
 * TypeORM DataSource options derived from ApiConfig.
 *
 * `synchronize` is false and will stay false. The schema is owned by `src/migrations/`
 * (data-model.md §2) and nothing else is allowed to touch it — a `synchronize: true` in a
 * money-path service silently drops columns on boot.
 */
import type { DataSourceOptions } from 'typeorm';

import type { ApiConfig } from './api-config.type';

/** Entities are registered per feature module via TypeOrmModule.forFeature. */
export function buildDataSourceOptions(config: ApiConfig): DataSourceOptions {
  const { database, runtime } = config;

  return {
    type: 'postgres',
    url: database.url,
    ssl: database.ssl ? { rejectUnauthorized: false } : false,
    synchronize: false,
    migrationsRun: false,
    logging: runtime.logLevel === 'debug' ? ['error', 'warn', 'migration'] : ['error'],
    entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
    migrations: [`${__dirname}/../migrations/*{.ts,.js}`],
    migrationsTableName: 'payzeno_migrations',
    extra: {
      max: database.poolSize,
      statement_timeout: database.statementTimeoutMs,
      application_name: `${runtime.serviceName}@${runtime.serviceVersion}`,
      // Postgres kills the connection rather than letting a wedged transaction hold locks
      // through a settlement window. See docs/runbooks/payzeno-api.md.
      idle_in_transaction_session_timeout: 30_000,
    },
  };
}

/**
 * Read-your-writes is required across the whole request: the idempotency interceptor commits
 * the `completed` row and the serializer then re-reads the entity. A replica would race.
 */
export function assertNoReplicaRouting(options: DataSourceOptions): void {
  if ('replication' in options && options.replication) {
    throw new Error('payzeno-api reads and writes the primary only — no replica routing');
  }
}
