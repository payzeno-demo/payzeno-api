import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 30 — `merchant.pricing_model`, `reserve_hold_days`, `payout_delay_days`,
 * `settlement_tolerance_minor`, and the `dispute_fee_schedule` table.
 *
 * Four commercial terms that were living in a spreadsheet and being applied by hand:
 *
 *   pricing_model              blended (platform_fee_bps + fixed) or interchange_plus, which
 *                              reads `merchant_fee_schedule` instead.
 *   reserve_hold_days          how long a reserve is held; drives `reserve_hold.release_on`.
 *   payout_delay_days          funds availability. 2 as standard, 7 for high risk.
 *   settlement_tolerance_minor per-item variance tolerance. Beyond it the item goes to
 *                              `variance_exceeded` and NOTHING is posted — the branch that
 *                              makes a wrong acquirer file detectable at all.
 *
 * `dispute_fee_schedule` replaces a currency-blind `default 1500` on `dispute.fee_minor`.
 * $15 in USD is about ten cents in JPY, and the fee is an acquirer contract term per region
 * anyway. Keyed `(acquirer, currency, effective_from)` so a repricing is a new row rather
 * than an update, and an old dispute keeps the fee that applied when it opened.
 *
 * — nmigration, month 12
 */
export class AddMerchantPricingAndDelays1728300000000 implements MigrationInterface {
  name = 'AddMerchantPricingAndDelays1728300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create type merchant_pricing_model as enum ('blended', 'interchange_plus')`,
    );

    await queryRunner.query(`
      alter table merchant
        add column pricing_model merchant_pricing_model not null default 'blended',
        add column reserve_hold_days integer not null default 0,
        add column payout_delay_days integer not null default 2,
        add column settlement_tolerance_minor bigint not null default 100
    `);

    await queryRunner.query(`
      update merchant set payout_delay_days = 7, reserve_hold_days = 90 where risk_tier = 'high'
    `);
    await queryRunner.query(`
      update merchant set payout_delay_days = 4 where risk_tier = 'elevated'
    `);

    await queryRunner.query(`
      create table dispute_fee_schedule (
        acquirer acquirer not null,
        currency char(3) not null,
        fee_minor bigint not null,
        effective_from date not null,
        primary key (acquirer, currency, effective_from)
      )
    `);

    // The rates in force at the time this landed, per the acquirer agreements.
    await queryRunner.query(`
      insert into dispute_fee_schedule (acquirer, currency, fee_minor, effective_from) values
        ('worldflow', 'USD', 1500, date '2025-01-01'),
        ('worldflow', 'EUR', 1400, date '2025-01-01'),
        ('worldflow', 'GBP', 1200, date '2025-01-01'),
        ('worldflow', 'JPY', 200000, date '2025-01-01'),
        ('nordpay',   'USD', 1750, date '2025-01-01'),
        ('nordpay',   'EUR', 1500, date '2025-01-01'),
        ('nordpay',   'GBP', 1300, date '2025-01-01'),
        ('nordpay',   'JPY', 225000, date '2025-01-01')
    `);

    await queryRunner.query(`
      create table merchant_fee_schedule (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        card_brand card_brand not null,
        card_funding card_funding not null,
        region_code varchar(8) not null default 'DOM',
        markup_bps integer not null,
        markup_fixed_minor bigint not null default 0,
        currency char(3) not null,
        effective_from date not null,
        effective_to date
      )
    `);
    await queryRunner.query(`
      create unique index uq_merchant_fee_schedule on merchant_fee_schedule
        (merchant_id, card_brand, card_funding, region_code, effective_from)
    `);
    await queryRunner.query(
      `create index ix_merchant_fee_schedule_merchant on merchant_fee_schedule (merchant_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists merchant_fee_schedule`);
    await queryRunner.query(`drop table if exists dispute_fee_schedule`);
    await queryRunner.query(`
      alter table merchant
        drop column if exists settlement_tolerance_minor,
        drop column if exists payout_delay_days,
        drop column if exists reserve_hold_days,
        drop column if exists pricing_model
    `);
    await queryRunner.query(`drop type if exists merchant_pricing_model`);
  }
}
