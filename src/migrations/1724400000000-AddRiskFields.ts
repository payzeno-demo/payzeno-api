import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 15 — `charge.risk_score`, `merchant.risk_tier`, `merchant.reserve_bps`.
 *
 * `risk_score` is the acquirer's 0-99 score captured at authorisation. We do not compute it
 * and we do not act on it in-line; it is stored so `RiskEvaluationService` has a distribution
 * to look at when a merchant's dispute rate moves.
 *
 * `reserve_bps` is the rolling reserve: basis points of every settlement held back against
 * future chargebacks. It is denormalised onto `payment.authorized` at authorisation time
 * (events.ts) because the ledger's `settlement_charge` projection needs the rate that was in
 * force when the charge happened, not the rate today.
 *
 * — osquash, month 8
 */
export class AddRiskFields1724400000000 implements MigrationInterface {
  name = 'AddRiskFields1724400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create type merchant_risk_tier as enum ('standard', 'elevated', 'high')`);

    await queryRunner.query(`alter table charge add column risk_score smallint not null default 0`);
    await queryRunner.query(`
      alter table merchant add column risk_tier merchant_risk_tier not null default 'standard'
    `);
    await queryRunner.query(`alter table merchant add column reserve_bps integer not null default 0`);

    // High-risk MCCs carried a reserve by hand-written agreement before this column existed.
    // Seeding them keeps the ledger's projection honest from the first event.
    await queryRunner.query(`
      update merchant
         set risk_tier = 'elevated', reserve_bps = 500
       where mcc in ('4722', '4511', '7011', '5962')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table merchant drop column if exists reserve_bps`);
    await queryRunner.query(`alter table merchant drop column if exists risk_tier`);
    await queryRunner.query(`alter table charge drop column if exists risk_score`);
    await queryRunner.query(`drop type if exists merchant_risk_tier`);
  }
}
