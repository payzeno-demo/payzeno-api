import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 14 — arc PERF. `ix_charge_merchant_created`.
 *
 * The console's charge list is `where merchant_id = $1 order by created_at desc limit 25`, and
 * it was sequentially scanning `charge` on every dashboard load. At month 7 that was 40ms; the
 * profile mregression posted on PAY-19xx showed it heading for seconds by year end, because
 * the scan cost grows with the whole table while the page size does not.
 *
 * `(merchant_id, created_at desc)` matches the keyset predicate `PayzenoRepository.paginateCursor`
 * generates, so the cursor page is an index-only range scan.
 *
 * Built CONCURRENTLY, which is why this migration has no transaction: Postgres refuses
 * `create index concurrently` inside one. The `down()` drops it the same way.
 *
 * — ytechdebt, month 7
 */
export class AddChargeMerchantCreatedIndex1723800000000 implements MigrationInterface {
  name = 'AddChargeMerchantCreatedIndex1723800000000';

  /** typeorm honours this and runs the migration outside its transaction wrapper. */
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create index concurrently if not exists ix_charge_merchant_created
        on charge (merchant_id, created_at desc)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index concurrently if exists ix_charge_merchant_created`);
  }
}
