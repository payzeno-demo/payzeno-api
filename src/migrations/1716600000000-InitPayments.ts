import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 02 — `payment_intent`, `charge` and their enums.
 *
 * Two things that look odd and are not:
 *
 *  - `payment_intent.latest_charge_id` has no foreign key. The charge references the intent,
 *    not the reverse; a mutual FK means neither row can be inserted first.
 *  - `charge` carries `pan_first_six` and `pan_encrypted`. That is what month 1 looked like.
 *    Migration 10 (arc PCI) drops both, and the argument for why they should never have
 *    existed is docs/adr/0014-client-side-tokenisation.md.
 *
 * `chk_charge_refund_le_capture` is the only invariant we let the database enforce on this
 * table, because a refund total that exceeds the captured amount is money we cannot get back.
 *
 * — osquash, month 1
 */
export class InitPayments1716600000000 implements MigrationInterface {
  name = 'InitPayments1716600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create type payment_intent_status as enum (
        'requires_payment_method', 'requires_confirmation', 'processing',
        'requires_capture', 'succeeded', 'canceled'
      )
    `);
    await queryRunner.query(`create type capture_method as enum ('automatic', 'manual')`);
    await queryRunner.query(`
      create type cancellation_reason as enum (
        'requested_by_customer', 'duplicate', 'fraudulent', 'abandoned', 'expired'
      )
    `);
    await queryRunner.query(`
      create type charge_status as enum (
        'pending', 'authorized', 'captured', 'settled', 'failed', 'voided', 'expired', 'reversed'
      )
    `);
    await queryRunner.query(`create type card_brand as enum ('visa', 'mastercard', 'amex', 'discover')`);
    await queryRunner.query(`create type card_funding as enum ('credit', 'debit', 'prepaid', 'unknown')`);
    await queryRunner.query(`create type acquirer as enum ('worldflow', 'nordpay')`);
    await queryRunner.query(`
      create type decline_code as enum (
        'do_not_honor', 'insufficient_funds', 'lost_card', 'stolen_card', 'expired_card',
        'incorrect_cvc', 'processing_error', 'issuer_unavailable', 'velocity_exceeded',
        'fraud_suspected'
      )
    `);

    await queryRunner.query(`
      create table payment_intent (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        amount_minor bigint not null check (amount_minor > 0),
        currency char(3) not null,
        status payment_intent_status not null,
        capture_method capture_method not null default 'automatic',
        payment_method_token text,
        customer_reference text,
        description text,
        latest_charge_id text,
        client_secret text not null,
        livemode boolean not null,
        metadata jsonb not null default '{}'::jsonb,
        canceled_at timestamptz,
        cancellation_reason cancellation_reason,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create index ix_payment_intent_merchant_created on payment_intent (merchant_id, created_at desc)`,
    );
    await queryRunner.query(`create index ix_payment_intent_status on payment_intent (status)`);
    await queryRunner.query(`
      create index pix_payment_intent_customer_ref on payment_intent (merchant_id, customer_reference)
        where customer_reference is not null
    `);
    await queryRunner.query(
      `create unique index uq_payment_intent_client_secret on payment_intent (client_secret)`,
    );
    await queryRunner.query(`
      create trigger payment_intent_set_updated_at before update on payment_intent
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table charge (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        payment_intent_id text not null references payment_intent (id) on delete restrict,
        amount_minor bigint not null,
        captured_amount_minor bigint not null default 0,
        refunded_amount_minor bigint not null default 0,
        currency char(3) not null,
        status charge_status not null,
        card_brand card_brand not null,
        card_last_four char(4) not null,
        card_exp_month smallint not null,
        card_exp_year smallint not null,
        card_country char(2),
        card_funding card_funding not null default 'unknown',
        pan_first_six char(6),
        pan_encrypted bytea,
        acquirer acquirer not null,
        network_transaction_id text,
        processor_reference text,
        authorization_code varchar(6),
        capture_method capture_method not null,
        failure_code decline_code,
        failure_message text,
        livemode boolean not null,
        metadata jsonb not null default '{}'::jsonb,
        authorized_at timestamptz,
        captured_at timestamptz,
        settled_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_charge_refund_le_capture
          check (refunded_amount_minor <= captured_amount_minor)
      )
    `);
    await queryRunner.query(`create index ix_charge_payment_intent_id on charge (payment_intent_id)`);
    await queryRunner.query(`create index ix_charge_status on charge (status)`);
    await queryRunner.query(`
      create trigger charge_set_updated_at before update on charge
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists charge`);
    await queryRunner.query(`drop table if exists payment_intent`);
    await queryRunner.query(`drop type if exists decline_code`);
    await queryRunner.query(`drop type if exists acquirer`);
    await queryRunner.query(`drop type if exists card_funding`);
    await queryRunner.query(`drop type if exists card_brand`);
    await queryRunner.query(`drop type if exists charge_status`);
    await queryRunner.query(`drop type if exists cancellation_reason`);
    await queryRunner.query(`drop type if exists capture_method`);
    await queryRunner.query(`drop type if exists payment_intent_status`);
  }
}
