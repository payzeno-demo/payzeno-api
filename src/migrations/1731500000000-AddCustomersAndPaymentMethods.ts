import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * platform-v2 money 1 — `customer` and `payment_method`, RFC platform-v2 §5.
 *
 * A customer belongs to one merchant and one mode, like everything merchant-scoped. A payment
 * method is a saved card: the reusable vault `pmt_` token, the card summary the vault resolved
 * it to, and the vault's keyed fingerprint. The token is the only card handle stored and it is
 * never returned by the API — everything outside payzeno-api names a saved card by `pm_` id.
 *
 * `uq_payment_method_customer_fingerprint` makes "save this card" idempotent per customer: the
 * same card saved twice is the same `pm_`. Detaching is a soft delete (`detached_at`) because
 * payment intents and subscriptions keep pointing at the row for their history.
 *
 * Additive only: new tables nothing in the running image reads.
 */
export class AddCustomersAndPaymentMethods1731500000000 implements MigrationInterface {
  name = 'AddCustomersAndPaymentMethods1731500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table customer (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        email citext,
        name text,
        default_payment_method_id text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create index ix_customer_merchant_created on customer (merchant_id, livemode, created_at desc)`,
    );
    await queryRunner.query(`create index ix_customer_merchant_email on customer (merchant_id, livemode, email)`);
    await queryRunner.query(`
      create trigger customer_set_updated_at before update on customer
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table payment_method (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        customer_id text not null references customer (id) on delete restrict,
        vault_token text not null,
        fingerprint text not null,
        card_brand card_brand not null,
        card_last_four char(4) not null,
        card_exp_month smallint not null,
        card_exp_year smallint not null,
        card_country char(2),
        card_funding card_funding not null default 'unknown',
        detached_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`
      create unique index uq_payment_method_customer_fingerprint on payment_method (customer_id, fingerprint)
        where detached_at is null
    `);
    await queryRunner.query(`create index ix_payment_method_customer on payment_method (customer_id, created_at)`);
    await queryRunner.query(`
      create trigger payment_method_set_updated_at before update on payment_method
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      alter table customer
        add constraint fk_customer_default_payment_method
        foreign key (default_payment_method_id) references payment_method (id) on delete set null
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table customer drop constraint if exists fk_customer_default_payment_method`);
    await queryRunner.query(`drop table if exists payment_method`);
    await queryRunner.query(`drop table if exists customer`);
  }
}
