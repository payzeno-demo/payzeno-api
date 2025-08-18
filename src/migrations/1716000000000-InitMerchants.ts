import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 01 — the first migration. `merchant`, `merchant_user`, `api_key`, their enums, and the
 * `set_updated_at()` trigger function every mutable table in this schema uses.
 *
 * The trigger is here rather than in each table's migration on purpose: `updated_at` is
 * maintained by the database, not by TypeORM's `@UpdateDateColumn`, so that a raw SQL write
 * (the outbox drain, a data fix, a consumer's conditional upsert) cannot leave a stale
 * timestamp behind.
 *
 * `merchant_user.email` is unique PER MERCHANT and not globally. One accountant holds a login
 * at four merchants, and a global unique index also leaks tenant existence at signup.
 *
 * — osquash, month 1
 */
export class InitMerchants1716000000000 implements MigrationInterface {
  name = 'InitMerchants1716000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create extension if not exists citext`);

    await queryRunner.query(`
      create or replace function set_updated_at() returns trigger as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$ language plpgsql
    `);

    await queryRunner.query(`
      create type merchant_status as enum (
        'pending_review', 'active', 'restricted', 'suspended', 'rejected', 'closed'
      )
    `);
    await queryRunner.query(`create type payout_schedule as enum ('daily', 'weekly', 'monthly', 'manual')`);
    await queryRunner.query(`create type merchant_user_role as enum ('owner', 'admin', 'developer', 'viewer')`);
    await queryRunner.query(`create type api_key_mode as enum ('test', 'live')`);

    await queryRunner.query(`
      create table merchant (
        id text primary key,
        legal_name text not null,
        display_name text not null,
        country char(2) not null,
        default_currency char(3) not null,
        status merchant_status not null default 'pending_review',
        mcc char(4) not null,
        payout_schedule payout_schedule not null default 'daily',
        platform_fee_bps integer not null default 290,
        platform_fee_fixed_minor bigint not null default 30,
        livemode boolean not null default false,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create unique index uq_merchant_legal_name_country on merchant (legal_name, country)`,
    );
    await queryRunner.query(`create index ix_merchant_status on merchant (status)`);
    await queryRunner.query(`
      create trigger merchant_set_updated_at before update on merchant
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table merchant_user (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        email citext not null,
        full_name text not null,
        password_hash text not null,
        role merchant_user_role not null,
        last_login_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create unique index uq_merchant_user_merchant_email on merchant_user (merchant_id, email)`,
    );
    await queryRunner.query(`create index ix_merchant_user_email on merchant_user (email)`);
    await queryRunner.query(`create index ix_merchant_user_merchant_id on merchant_user (merchant_id)`);
    await queryRunner.query(`
      create trigger merchant_user_set_updated_at before update on merchant_user
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table api_key (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        name text not null,
        mode api_key_mode not null,
        prefix varchar(12) not null,
        secret_hash text not null,
        last_four char(4) not null,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      )
    `);
    await queryRunner.query(`create index ix_api_key_merchant_id on api_key (merchant_id)`);
    await queryRunner.query(
      `create unique index uq_api_key_secret_hash on api_key (secret_hash)`,
    );
    await queryRunner.query(
      `create index pix_api_key_active on api_key (merchant_id) where revoked_at is null`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists api_key`);
    await queryRunner.query(`drop table if exists merchant_user`);
    await queryRunner.query(`drop table if exists merchant`);
    await queryRunner.query(`drop type if exists api_key_mode`);
    await queryRunner.query(`drop type if exists merchant_user_role`);
    await queryRunner.query(`drop type if exists payout_schedule`);
    await queryRunner.query(`drop type if exists merchant_status`);
    await queryRunner.query(`drop function if exists set_updated_at()`);
  }
}
