import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 10 — arc PCI. Drops `charge.pan_first_six` and `charge.pan_encrypted`.
 *
 * This is the migration the whole PCI scope reduction exists to reach. Once these two columns
 * are gone, `payzeno_api` holds no cardholder data at all: the brand, the last four and the
 * expiry are permitted under SAQ A-EP, and everything else lives in the vault behind a token.
 * docs/compliance/pci-scope.md is the argument; docs/adr/0014-client-side-tokenisation.md is
 * how we stopped writing them in the first place.
 *
 * Two-phase, as the review rule requires: `ChargeAuthorizationService` stopped writing both
 * columns in the release before this one. This migration only removes what nothing has
 * populated for a fortnight, after backfilling `card_last_four` for the handful of rows that
 * had a PAN but no last four.
 *
 * The `down()` restores the columns but NOT the data, and that is deliberate. There is no
 * legitimate reason to want it back, and the encrypted blobs are gone from the backup set
 * inside the retention window.
 *
 * — dhotfix, month 5
 */
export class DropCardPanColumns1721400000000 implements MigrationInterface {
  name = 'DropCardPanColumns1721400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rows written before card_last_four became mandatory. Small and bounded; a batched loop
    // would be theatre at this size.
    await queryRunner.query(`
      update charge
         set card_last_four = right(pan_first_six, 4)
       where (card_last_four is null or card_last_four = '')
         and pan_first_six is not null
    `);

    await queryRunner.query(`alter table charge drop column if exists pan_encrypted`);
    await queryRunner.query(`alter table charge drop column if exists pan_first_six`);

    await queryRunner.query(`alter table charge alter column card_last_four set not null`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table charge alter column card_last_four drop not null`);
    await queryRunner.query(`alter table charge add column pan_first_six char(6)`);
    await queryRunner.query(`alter table charge add column pan_encrypted bytea`);
  }
}
