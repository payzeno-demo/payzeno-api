import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * platform-v2 money 4 — the new columns on `payment_intent`, `charge` and `checkout_session`.
 *
 *   payment_intent    customer_id, payment_method_id, receipt_email, presentment (the original
 *                     price when the shopper paid in another currency, §7), review_id (§8),
 *                     subscription_id (§6). `amount_minor` may now be 0: a `setup` checkout
 *                     session has an intent behind it (its client secret is the vault bearer)
 *                     that never charges. `ConfirmPaymentFlow` refuses to confirm one.
 *   charge            card_fingerprint, shopper_ip, shopper_country and the risk outcome —
 *                     the velocity signals are queries over these (two partial indexes).
 *   checkout_session  mode, customer, price, subscription, save-card options, adaptive pricing.
 *                     `amount_minor` is 0 exactly for `setup`.
 *
 * Every column is nullable or defaulted, so the running image keeps inserting rows unchanged;
 * the two relaxed checks only admit rows the old code never writes.
 */
export class AddPlatformV2PaymentColumns1731500300000 implements MigrationInterface {
  name = 'AddPlatformV2PaymentColumns1731500300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table payment_intent
        add column customer_id text references customer (id) on delete restrict,
        add column payment_method_id text references payment_method (id) on delete restrict,
        add column receipt_email text,
        add column presentment jsonb,
        add column review_id text references review (id) on delete set null,
        add column subscription_id text references customer_subscription (id) on delete set null
    `);
    await queryRunner.query(`alter table payment_intent drop constraint if exists payment_intent_amount_minor_check`);
    await queryRunner.query(
      `alter table payment_intent add constraint chk_payment_intent_amount check (amount_minor >= 0)`,
    );
    await queryRunner.query(
      `create index ix_payment_intent_subscription on payment_intent (subscription_id) where subscription_id is not null`,
    );

    await queryRunner.query(`
      alter table charge
        add column card_fingerprint text,
        add column shopper_ip text,
        add column shopper_country char(2),
        add column risk_outcome text check (risk_outcome in ('allow', 'review', 'block'))
    `);
    await queryRunner.query(`
      create index pix_charge_card_fingerprint on charge (card_fingerprint, created_at)
        where card_fingerprint is not null
    `);
    await queryRunner.query(`
      create index pix_charge_shopper_ip on charge (shopper_ip, created_at)
        where shopper_ip is not null
    `);

    await queryRunner.query(`create type checkout_mode as enum ('payment', 'subscription', 'setup')`);
    await queryRunner.query(`
      alter table checkout_session
        add column mode checkout_mode not null default 'payment',
        add column customer_id text references customer (id) on delete restrict,
        add column price_id text references price (id) on delete restrict,
        add column subscription_id text references customer_subscription (id) on delete set null,
        add column save_payment_method text not null default 'never'
          check (save_payment_method in ('optional', 'never')),
        add column adaptive_pricing boolean not null default true,
        add column save_card_requested boolean not null default false
    `);
    await queryRunner.query(`alter table checkout_session drop constraint if exists checkout_session_amount_minor_check`);
    await queryRunner.query(`
      alter table checkout_session add constraint chk_checkout_session_amount
        check ((mode = 'setup' and amount_minor = 0) or (mode <> 'setup' and amount_minor > 0))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table checkout_session drop constraint if exists chk_checkout_session_amount`);
    await queryRunner.query(`delete from checkout_session where mode = 'setup'`);
    await queryRunner.query(
      `alter table checkout_session add constraint checkout_session_amount_minor_check check (amount_minor > 0)`,
    );
    await queryRunner.query(`
      alter table checkout_session
        drop column if exists save_card_requested,
        drop column if exists adaptive_pricing,
        drop column if exists save_payment_method,
        drop column if exists subscription_id,
        drop column if exists price_id,
        drop column if exists customer_id,
        drop column if exists mode
    `);
    await queryRunner.query(`drop type if exists checkout_mode`);

    await queryRunner.query(`drop index if exists pix_charge_shopper_ip`);
    await queryRunner.query(`drop index if exists pix_charge_card_fingerprint`);
    await queryRunner.query(`
      alter table charge
        drop column if exists risk_outcome,
        drop column if exists shopper_country,
        drop column if exists shopper_ip,
        drop column if exists card_fingerprint
    `);

    await queryRunner.query(`drop index if exists ix_payment_intent_subscription`);
    await queryRunner.query(`alter table payment_intent drop constraint if exists chk_payment_intent_amount`);
    await queryRunner.query(`delete from payment_intent where amount_minor = 0`);
    await queryRunner.query(
      `alter table payment_intent add constraint payment_intent_amount_minor_check check (amount_minor > 0)`,
    );
    await queryRunner.query(`
      alter table payment_intent
        drop column if exists subscription_id,
        drop column if exists review_id,
        drop column if exists presentment,
        drop column if exists receipt_email,
        drop column if exists payment_method_id,
        drop column if exists customer_id
    `);
  }
}
