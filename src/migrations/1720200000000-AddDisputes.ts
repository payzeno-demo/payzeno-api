import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 08 — `dispute`.
 *
 * `fee_minor` has no default. A currency-blind `default 1500` is $15 in USD and about ten
 * cents in JPY, and the dispute fee is an acquirer contract term anyway — it comes from
 * `dispute_fee_schedule`, which migration 30 adds.
 *
 * `uq_dispute_charge_open` (migration 17) is what stops two acquirer webhooks for the same
 * chargeback opening two disputes. Until then `DisputesService.openFromWebhook` had nothing
 * to collide against.
 *
 * — ytechdebt, month 4
 */
export class AddDisputes1720200000000 implements MigrationInterface {
  name = 'AddDisputes1720200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create type dispute_status as enum (
        'needs_response', 'under_review', 'won', 'lost',
        'warning_needs_response', 'warning_closed'
      )
    `);
    await queryRunner.query(`
      create type dispute_reason as enum (
        'fraudulent', 'product_not_received', 'product_unacceptable', 'duplicate',
        'subscription_canceled', 'credit_not_processed', 'general'
      )
    `);

    await queryRunner.query(`
      create table dispute (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        charge_id text not null references charge (id) on delete restrict,
        amount_minor bigint not null,
        fee_minor bigint not null,
        currency char(3) not null,
        status dispute_status not null,
        reason dispute_reason not null,
        network_reason_code varchar(8) not null,
        evidence_due_by timestamptz,
        evidence jsonb not null default '{}'::jsonb,
        is_charge_refundable boolean not null default false,
        liability_shifted boolean not null default false,
        submitted_at timestamptz,
        resolved_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`create index ix_dispute_merchant_status on dispute (merchant_id, status)`);
    await queryRunner.query(`
      create index pix_dispute_evidence_due on dispute (evidence_due_by)
        where status = 'needs_response'
    `);
    await queryRunner.query(`
      create trigger dispute_set_updated_at before update on dispute
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists dispute`);
    await queryRunner.query(`drop type if exists dispute_reason`);
    await queryRunner.query(`drop type if exists dispute_status`);
  }
}
