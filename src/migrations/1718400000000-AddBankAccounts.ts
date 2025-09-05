import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 05 — `bank_account`.
 *
 * `account_number_token` holds a vault token, never the number. Payzeno does not store bank
 * account numbers any more than it stores PANs, and the payout rail resolves the token at
 * instruction time.
 *
 * `pix_bank_account_default` is unique and partial: a merchant may have many accounts but
 * exactly one default per `(currency, livemode)`. Without the uniqueness, `PayoutInitiator`
 * picks whichever row the planner happens to return first.
 *
 * The scheme columns (IBAN, sort code, BIC) and their check constraint arrive in migration 29.
 *
 * — ytechdebt, month 3
 */
export class AddBankAccounts1718400000000 implements MigrationInterface {
  name = 'AddBankAccounts1718400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create type bank_account_status as enum ('new', 'validated', 'verification_failed', 'errored')
    `);

    await queryRunner.query(`
      create table bank_account (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        country char(2) not null,
        currency char(3) not null,
        bank_name text,
        account_number_token text not null,
        last_four char(4),
        routing_last_four char(4),
        status bank_account_status not null default 'new',
        is_default boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`create index ix_bank_account_merchant_id on bank_account (merchant_id)`);
    await queryRunner.query(`
      create unique index pix_bank_account_default on bank_account (merchant_id, currency)
        where is_default
    `);
    await queryRunner.query(`
      create trigger bank_account_set_updated_at before update on bank_account
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists bank_account`);
    await queryRunner.query(`drop type if exists bank_account_status`);
  }
}
