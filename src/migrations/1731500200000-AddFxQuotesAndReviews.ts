import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * platform-v2 money 3 — `fx_quote` (§7) and `review` (§8).
 *
 * `fx_quote` is the record of what a shopper was shown: the provider mid-rate, Payzeno's
 * markup and the rate charged, valid for 30 minutes. Rates are `numeric`, never float — the
 * same rule as money — and travel as decimal strings. Append-only: a quote is never edited,
 * so there is no `updated_at`.
 *
 * `review` is a payment held by platform risk rules: the authorisation is kept uncaptured
 * until a Payzeno risk analyst approves (capture) or declines (void). At most one open review
 * per intent (`uq_review_open_payment_intent`).
 *
 * Additive only.
 */
export class AddFxQuotesAndReviews1731500200000 implements MigrationInterface {
  name = 'AddFxQuotesAndReviews1731500200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table fx_quote (
        id text primary key,
        from_currency char(3) not null,
        to_currency char(3) not null,
        mid_rate numeric(24, 10) not null check (mid_rate > 0),
        markup_bps integer not null check (markup_bps between 0 and 10000),
        rate numeric(24, 10) not null check (rate > 0),
        provider_as_of timestamptz,
        checkout_session_id text,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        constraint chk_fx_quote_pair check (from_currency <> to_currency)
      )
    `);
    await queryRunner.query(
      `create index ix_fx_quote_checkout_session on fx_quote (checkout_session_id, to_currency, expires_at desc)`,
    );

    await queryRunner.query(`
      create table review (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        payment_intent_id text not null references payment_intent (id) on delete restrict,
        charge_id text not null references charge (id) on delete restrict,
        status text not null default 'open' check (status in ('open', 'approved', 'declined')),
        rules text[] not null default '{}',
        risk_score smallint not null default 0,
        amount_minor bigint not null,
        currency char(3) not null,
        ip_country char(2),
        card_country char(2),
        opened_at timestamptz not null,
        closed_at timestamptz,
        closed_by text,
        note text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`
      create unique index uq_review_open_payment_intent on review (payment_intent_id) where status = 'open'
    `);
    await queryRunner.query(`create index ix_review_status_opened on review (status, opened_at desc)`);
    await queryRunner.query(`create index ix_review_merchant_created on review (merchant_id, livemode, created_at desc)`);
    await queryRunner.query(`
      create trigger review_set_updated_at before update on review
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists review`);
    await queryRunner.query(`drop table if exists fx_quote`);
  }
}
