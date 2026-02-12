import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 13 — `merchant.capture_at_settlement` and its partial index.
 *
 * A column, not a feature flag. Deferred capture is a per-merchant commercial arrangement for
 * the travel and lodging MCCs: payzeno-api authorises, and payzeno-ledger issues the capture
 * when the acquirer file lands, so the merchant is not holding an authorisation for three
 * weeks. Flags are for rollouts; this is a contract term and it belongs on the row.
 *
 * `merchant.updated` is the only propagation path for it — the ledger's `merchant_projection`
 * learns about it off the bus and nowhere else.
 *
 * This is also, precisely, the blast radius of arc INC. Only merchants with this column true
 * can be double-CHARGED rather than double-POSTED, because only for them does the ledger own
 * the acquirer call. `LedgerEventsConsumer` reads it before deciding whether a
 * `settlement.duplicate_detected` needs a human within the hour.
 *
 * — dhotfix, month 7
 */
export class AddCaptureAtSettlement1723200000000 implements MigrationInterface {
  name = 'AddCaptureAtSettlement1723200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table merchant add column capture_at_settlement boolean not null default false`,
    );

    await queryRunner.query(`
      create index pix_merchant_capture_at_settlement on merchant (id)
        where capture_at_settlement
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists pix_merchant_capture_at_settlement`);
    await queryRunner.query(`alter table merchant drop column if exists capture_at_settlement`);
  }
}
