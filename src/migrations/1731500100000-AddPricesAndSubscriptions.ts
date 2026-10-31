import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * platform-v2 money 2 — `price` and `customer_subscription`, RFC platform-v2 §6.
 *
 * The table is `customer_subscription`, not `subscription`: billing-legacy's `sub_`
 * subscriptions are how Payzeno bills merchants, and these (`csub_`) are a merchant billing
 * *their* customers. The two must never be confused in a query, so they do not share a name.
 *
 * `SubscriptionRenewalJob` reads the two partial indexes: active subscriptions by period end,
 * and past-due ones by their next retry. `past_due_since` anchors the +1d/+3d/+7d retry
 * schedule to the first failure, so a clock that jumps forward still lands every retry on
 * its own day rather than drifting from whenever the job happened to run.
 *
 * Additive only: new tables nothing in the running image reads.
 */
export class AddPricesAndSubscriptions1731500100000 implements MigrationInterface {
  name = 'AddPricesAndSubscriptions1731500100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table price (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        product_name text not null,
        unit_amount_minor bigint not null check (unit_amount_minor > 0),
        currency char(3) not null,
        recurring_interval text check (recurring_interval in ('month', 'year')),
        recurring_interval_count smallint check (recurring_interval_count between 1 and 12),
        active boolean not null default true,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_price_recurring_pair
          check ((recurring_interval is null) = (recurring_interval_count is null))
      )
    `);
    await queryRunner.query(`create index ix_price_merchant_created on price (merchant_id, livemode, created_at desc)`);
    await queryRunner.query(`
      create trigger price_set_updated_at before update on price
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table customer_subscription (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        customer_id text not null references customer (id) on delete restrict,
        price_id text not null references price (id) on delete restrict,
        status text not null check (status in ('active', 'past_due', 'canceled')),
        current_period_start timestamptz not null,
        current_period_end timestamptz not null,
        cancel_at_period_end boolean not null default false,
        canceled_at timestamptz,
        default_payment_method_id text references payment_method (id) on delete set null,
        latest_payment_intent_id text references payment_intent (id) on delete set null,
        next_retry_at timestamptz,
        failed_attempts smallint not null default 0,
        past_due_since timestamptz,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_customer_subscription_period check (current_period_end > current_period_start)
      )
    `);
    await queryRunner.query(
      `create index ix_customer_subscription_merchant_created on customer_subscription (merchant_id, livemode, created_at desc)`,
    );
    await queryRunner.query(
      `create index ix_customer_subscription_customer on customer_subscription (customer_id)`,
    );
    await queryRunner.query(`
      create index pix_customer_subscription_active_due on customer_subscription (current_period_end)
        where status = 'active'
    `);
    await queryRunner.query(`
      create index pix_customer_subscription_retry_due on customer_subscription (next_retry_at)
        where status = 'past_due'
    `);
    await queryRunner.query(`
      create trigger customer_subscription_set_updated_at before update on customer_subscription
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists customer_subscription`);
    await queryRunner.query(`drop table if exists price`);
  }
}
