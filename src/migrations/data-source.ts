/**
 * The TypeORM DataSource the CLI uses. `pnpm migration:run` points at this file.
 *
 * `synchronize` is false and will stay false. Every schema change in `payzeno_api` is a
 * numbered migration in this directory, reviewed like code, with a real `down()`. The one
 * time somebody turned synchronize on in a local environment it dropped
 * `uq_charge_processor_reference` because the entity decorator disagreed with the migration,
 * and that index is INC hardening.
 *
 * Entities are globbed rather than listed: sixteen imports here is sixteen chances to forget
 * one, and a missing entity fails at runtime with a message about metadata rather than about
 * the table you actually changed.
 *
 * Migrations are the opposite — listed by hand, in order. A glob resolves against `dist/` in
 * a container and against `src/` under ts-node, and the two disagreed exactly once: a stale
 * `.js` left behind by an old build re-ran migration 16 against staging. The explicit list is
 * also what `test/e2e/migrations.e2e-spec.ts` counts — the contracted chain (data-model.md §2)
 * is 32 long and the test says so out loud.
 *
 * The bookkeeping table is `payzeno_migrations` here and in `src/config/database.config.ts`.
 * Those two names have to agree: if the CLI writes one table and the app reads another, the
 * app boots believing the schema is empty.
 */
import 'reflect-metadata';

import { DataSource, type DataSourceOptions } from 'typeorm';

import { loadConfiguration } from '../config/configuration';
import { InitMerchants1716000000000 } from './1716000000000-InitMerchants';
import { InitPayments1716600000000 } from './1716600000000-InitPayments';
import { AddIdempotencyRecord1717200000000 } from './1717200000000-AddIdempotencyRecord';
import { AddRefunds1717800000000 } from './1717800000000-AddRefunds';
import { AddBankAccounts1718400000000 } from './1718400000000-AddBankAccounts';
import { AddWebhooks1719000000000 } from './1719000000000-AddWebhooks';
import { AddEventOutbox1719600000000 } from './1719600000000-AddEventOutbox';
import { AddDisputes1720200000000 } from './1720200000000-AddDisputes';
import { AddAuditLog1720800000000 } from './1720800000000-AddAuditLog';
import { DropCardPanColumns1721400000000 } from './1721400000000-DropCardPanColumns';
import { AddStaffUsers1721700000000 } from './1721700000000-AddStaffUsers';
import { AddStatementDescriptor1722000000000 } from './1722000000000-AddStatementDescriptor';
import { AddChargeSettlementBatchId1722600000000 } from './1722600000000-AddChargeSettlementBatchId';
import { AddCaptureAtSettlement1723200000000 } from './1723200000000-AddCaptureAtSettlement';
import { AddApiKeyLookupHash1723500000000 } from './1723500000000-AddApiKeyLookupHash';
import { AddChargeMerchantCreatedIndex1723800000000 } from './1723800000000-AddChargeMerchantCreatedIndex';
import { AddIdempotencyLease1724100000000 } from './1724100000000-AddIdempotencyLease';
import { AddRiskFields1724400000000 } from './1724400000000-AddRiskFields';
import { AddWebhookSecretEncryption1724700000000 } from './1724700000000-AddWebhookSecretEncryption';
import { AddUniqueProcessorReference1725000000000 } from './1725000000000-AddUniqueProcessorReference';
import { AddSettlementCompletion1725300000000 } from './1725300000000-AddSettlementCompletion';
import { AddDisputeUniqueOpen1725600000000 } from './1725600000000-AddDisputeUniqueOpen';
import { AddProcessedEventConsumerKey1725900000000 } from './1725900000000-AddProcessedEventConsumerKey';
import { AddWebhookEventTypeIndex1726200000000 } from './1726200000000-AddWebhookEventTypeIndex';
import { AddWebhookEventSourceId1726500000000 } from './1726500000000-AddWebhookEventSourceId';
import { AddApiKeyScopes1726800000000 } from './1726800000000-AddApiKeyScopes';
import { AddCardScaFields1727100000000 } from './1727100000000-AddCardScaFields';
import { AddInvoiceProjection1727400000000 } from './1727400000000-AddInvoiceProjection';
import { AddBankAccountSchemes1727700000000 } from './1727700000000-AddBankAccountSchemes';
import { AddMerchantPricingAndDelays1728300000000 } from './1728300000000-AddMerchantPricingAndDelays';
import { AddLivemodeToMerchantScoped1728900000000 } from './1728900000000-AddLivemodeToMerchantScoped';
import { AddChargeAuthorizationExpiry1729500000000 } from './1729500000000-AddChargeAuthorizationExpiry';

/** The name every DataSource in this repo uses for TypeORM's bookkeeping table. */
export const MIGRATIONS_TABLE = 'payzeno_migrations';

/**
 * The contracted chain, data-model.md §2, in execution order. Append only — a migration whose
 * timestamp is lower than the last entry here does not get merged, because a rebase would
 * silently reorder two dependent DDL statements and nobody would notice until staging.
 */
export const migrations: Function[] = [
  InitMerchants1716000000000,
  InitPayments1716600000000,
  AddIdempotencyRecord1717200000000,
  AddRefunds1717800000000,
  AddBankAccounts1718400000000,
  AddWebhooks1719000000000,
  AddEventOutbox1719600000000,
  AddDisputes1720200000000,
  AddAuditLog1720800000000,
  DropCardPanColumns1721400000000,
  AddStaffUsers1721700000000,
  AddStatementDescriptor1722000000000,
  AddChargeSettlementBatchId1722600000000,
  AddCaptureAtSettlement1723200000000,
  AddApiKeyLookupHash1723500000000,
  AddChargeMerchantCreatedIndex1723800000000,
  AddIdempotencyLease1724100000000,
  AddRiskFields1724400000000,
  AddWebhookSecretEncryption1724700000000,
  AddUniqueProcessorReference1725000000000,
  AddSettlementCompletion1725300000000,
  AddDisputeUniqueOpen1725600000000,
  AddProcessedEventConsumerKey1725900000000,
  AddWebhookEventTypeIndex1726200000000,
  AddWebhookEventSourceId1726500000000,
  AddApiKeyScopes1726800000000,
  AddCardScaFields1727100000000,
  AddInvoiceProjection1727400000000,
  AddBankAccountSchemes1727700000000,
  AddMerchantPricingAndDelays1728300000000,
  AddLivemodeToMerchantScoped1728900000000,
  AddChargeAuthorizationExpiry1729500000000,
];

const config = loadConfiguration();

/**
 * Exported separately from the DataSource so the e2e harness can spread it and override
 * `url`/`logging` without re-reading the environment — `test/support/db.ts`,
 * `test/support/e2e.global-setup.ts`, `test/e2e/migrations.e2e-spec.ts`.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: config.database.url,
  entities: [`${__dirname}/../**/*.entity.{ts,js}`],
  migrations,
  migrationsTableName: MIGRATIONS_TABLE,
  synchronize: false,
  logging: config.runtime.nodeEnv === 'development' ? ['error', 'migration'] : ['error'],
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  extra: {
    max: config.database.poolSize,
    statement_timeout: config.database.statementTimeoutMs,
  },
};

export const AppDataSource = new DataSource(dataSourceOptions);

/**
 * `test/e2e/migrations.e2e-spec.ts` runs the whole chain up and back down against a scratch
 * database. It needs a DataSource it can point at a different url without re-reading the
 * environment.
 */
export function createMigrationDataSource(url: string): DataSource {
  return new DataSource({
    ...dataSourceOptions,
    url,
    logging: false,
  });
}

export default AppDataSource;
