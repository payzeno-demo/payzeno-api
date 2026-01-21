import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 12 — arc MIG. `charge.settlement_batch_id` and `pix_charge_unsettled`.
 *
 * The first column in `payzeno_api` that holds one of the ledger's ids. There is deliberately
 * NO foreign key: the two databases are never joined and never share a connection, so the
 * reference is by value and its integrity is the bus's problem, not the planner's.
 *
 * `pix_charge_unsettled` is the interesting half. It indexes exactly the charges that have
 * been captured and have not been settled, which is the set that should always be small and
 * always be draining. When it is not, something upstream has gone wrong.
 *
 * It had no reader for six months. `UnsettledChargeSweepJob` (PAY-2058) is the reader, and it
 * was written after the incident that this index would have surfaced within the hour.
 *
 * — nmigration, month 6
 */
export class AddChargeSettlementBatchId1722600000000 implements MigrationInterface {
  name = 'AddChargeSettlementBatchId1722600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table charge add column settlement_batch_id text`);

    await queryRunner.query(`
      create index pix_charge_unsettled on charge (settlement_batch_id)
        where settlement_batch_id is null and status = 'captured'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists pix_charge_unsettled`);
    await queryRunner.query(`alter table charge drop column if exists settlement_batch_id`);
  }
}
