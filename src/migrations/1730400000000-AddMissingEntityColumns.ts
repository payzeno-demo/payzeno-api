import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 34 — three columns the entities have been writing and reading without the schema having them.
 *
 *   api_key.updated_at                 ApiKeyEntity extends BaseEntity, so every insert names
 *                                      it; minting a key failed with "column does not exist".
 *   bank_account.account_holder_name   BankAccountsService.create writes it from the request.
 *   merchant_user.status               `invited` / `active` / `disabled`. The login lookup filters
 *                                      on it and user removal writes it, so neither worked.
 *
 * Found by diffing every entity's metadata against information_schema on a freshly migrated
 * database. All three are additive: existing rows get a value that is true for them (`active`
 * for users who could already log in, the insert time for `updated_at`) and the running code
 * does not read any of them before it is deployed.
 *
 * `account_holder_name` is backfilled as '' — the holder name of an existing account was only
 * ever sent to the vault — and the default is dropped afterwards so a new row must carry one.
 */
export class AddMissingEntityColumns1730400000000 implements MigrationInterface {
  name = 'AddMissingEntityColumns1730400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table api_key add column if not exists updated_at timestamptz not null default now()`,
    );
    await queryRunner.query(`update api_key set updated_at = created_at`);
    await queryRunner.query(`
      create trigger api_key_set_updated_at before update on api_key
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(
      `alter table bank_account add column if not exists account_holder_name text not null default ''`,
    );
    await queryRunner.query(`alter table bank_account alter column account_holder_name drop default`);

    await queryRunner.query(
      `alter table merchant_user add column if not exists status text not null default 'active'`,
    );
    await queryRunner.query(`
      alter table merchant_user
        add constraint chk_merchant_user_status check (status in ('invited', 'active', 'disabled'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table merchant_user drop constraint if exists chk_merchant_user_status`);
    await queryRunner.query(`alter table merchant_user drop column if exists status`);
    await queryRunner.query(`alter table bank_account drop column if exists account_holder_name`);
    await queryRunner.query(`drop trigger if exists api_key_set_updated_at on api_key`);
    await queryRunner.query(`alter table api_key drop column if exists updated_at`);
  }
}
