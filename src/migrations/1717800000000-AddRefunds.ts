import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 04 — `refund`.
 *
 * `uq_refund_processor_reference` is what stops a retried acquirer call turning into two
 * refunds. The acquirer's reference is the only thing both sides agree on; our own id is
 * minted before the call and therefore proves nothing about whether the call landed.
 *
 * `livemode` arrives in migration 31 with the rest of the merchant-scoped tables.
 *
 * — ytechdebt, month 2
 */
export class AddRefunds1717800000000 implements MigrationInterface {
  name = 'AddRefunds1717800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create type refund_status as enum ('pending', 'succeeded', 'failed', 'canceled')`,
    );
    await queryRunner.query(`
      create type refund_reason as enum (
        'duplicate', 'fraudulent', 'requested_by_customer', 'expired_uncaptured_auth'
      )
    `);

    await queryRunner.query(`
      create table refund (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        charge_id text not null references charge (id) on delete restrict,
        amount_minor bigint not null check (amount_minor > 0),
        currency char(3) not null,
        status refund_status not null,
        reason refund_reason not null,
        failure_reason text,
        processor_reference text,
        metadata jsonb not null default '{}'::jsonb,
        succeeded_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`create index ix_refund_charge_id on refund (charge_id)`);
    await queryRunner.query(
      `create index ix_refund_merchant_created on refund (merchant_id, created_at desc)`,
    );
    await queryRunner.query(
      `create unique index uq_refund_processor_reference on refund (processor_reference)`,
    );
    await queryRunner.query(`
      create trigger refund_set_updated_at before update on refund
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists refund`);
    await queryRunner.query(`drop type if exists refund_reason`);
    await queryRunner.query(`drop type if exists refund_status`);
  }
}
