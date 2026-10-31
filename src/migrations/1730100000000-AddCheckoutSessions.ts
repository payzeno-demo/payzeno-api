import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 33 — `checkout_session`, the Payzeno-hosted payment page and its embeddable iframe.
 *
 * One row per session, one PaymentIntent behind it (created in the same request, never shared).
 * The PaymentIntent stays the source of truth for money; the session only records what the
 * shopper was shown and where to send them, and its `status` is reconciled from the intent's.
 *
 * `client_secret` is stored and looked up exactly like `payment_intent.client_secret`: plain
 * text under a unique index. It reads and confirms one session and nothing else, it lives in a
 * URL fragment on the shopper's machine, and the vault and acquirer never see it.
 *
 * Additive only: a new table, nothing the running image reads. Safe to run ahead of the rollout.
 */
export class AddCheckoutSessions1730100000000 implements MigrationInterface {
  name = 'AddCheckoutSessions1730100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create type checkout_session_status as enum ('open', 'complete', 'expired')`,
    );
    await queryRunner.query(`create type checkout_ui_mode as enum ('hosted', 'embedded')`);

    await queryRunner.query(`
      create table checkout_session (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        payment_intent_id text not null references payment_intent (id) on delete restrict,
        status checkout_session_status not null default 'open',
        ui_mode checkout_ui_mode not null,
        amount_minor bigint not null check (amount_minor > 0),
        currency char(3) not null,
        description text,
        line_items jsonb not null default '[]'::jsonb,
        customer_reference text,
        customer_email text,
        success_url text,
        cancel_url text,
        allowed_origin text,
        client_secret text not null,
        livemode boolean not null,
        metadata jsonb not null default '{}'::jsonb,
        expires_at timestamptz not null,
        completed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_checkout_session_hosted_success_url
          check (ui_mode <> 'hosted' or success_url is not null),
        constraint chk_checkout_session_embedded_origin
          check (ui_mode <> 'embedded' or allowed_origin is not null)
      )
    `);

    await queryRunner.query(
      `create index ix_checkout_session_merchant_created on checkout_session (merchant_id, created_at desc)`,
    );
    await queryRunner.query(
      `create unique index uq_checkout_session_client_secret on checkout_session (client_secret)`,
    );
    await queryRunner.query(
      `create unique index uq_checkout_session_payment_intent on checkout_session (payment_intent_id)`,
    );
    // CheckoutExpiryJob's scan: open sessions only, by deadline.
    await queryRunner.query(`
      create index pix_checkout_session_open_expiry on checkout_session (expires_at)
        where status = 'open'
    `);
    await queryRunner.query(`
      create trigger checkout_session_set_updated_at before update on checkout_session
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists checkout_session`);
    await queryRunner.query(`drop type if exists checkout_ui_mode`);
    await queryRunner.query(`drop type if exists checkout_session_status`);
  }
}
