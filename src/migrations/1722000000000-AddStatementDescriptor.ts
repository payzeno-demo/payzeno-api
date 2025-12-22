import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 11 — `merchant.statement_descriptor` and `payment_intent.statement_descriptor`.
 *
 * What the cardholder sees on their statement. 22 characters because that is what the
 * networks carry; anything longer is truncated by the acquirer in a way we do not control,
 * and a truncated descriptor is the single largest driver of `fraudulent` disputes from
 * cardholders who simply did not recognise the name.
 *
 * The per-intent override exists for marketplaces: one merchant of record, many sub-brands.
 *
 * — ytechdebt, month 6
 */
export class AddStatementDescriptor1722000000000 implements MigrationInterface {
  name = 'AddStatementDescriptor1722000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table merchant add column statement_descriptor varchar(22)`);
    await queryRunner.query(`alter table payment_intent add column statement_descriptor varchar(22)`);

    // Seed the merchant-level value from the display name so the column is useful the day it
    // ships rather than after everyone has been asked to fill in a form.
    await queryRunner.query(`
      update merchant
         set statement_descriptor = upper(substring(regexp_replace(display_name, '[^a-zA-Z0-9 ]', '', 'g') from 1 for 22))
       where statement_descriptor is null
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table payment_intent drop column if exists statement_descriptor`);
    await queryRunner.query(`alter table merchant drop column if exists statement_descriptor`);
  }
}
