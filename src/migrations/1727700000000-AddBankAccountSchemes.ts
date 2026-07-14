import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 29 — `bank_account.scheme` plus the IBAN / sort-code columns and
 * `chk_bank_account_scheme_fields`.
 *
 * We took EUR and GBP merchants before we could describe their bank details. A SEPA account
 * has an IBAN and a BIC, a UK account has a six-digit sort code, and neither has an ABA
 * routing number — so everything non-US was landing with a null routing number and a payout
 * instruction the rail rejected.
 *
 * The check constraint is per-scheme rather than "all the columns not null", because that is
 * the actual rule:
 *   aba          → routing_last_four
 *   iban         → iban_last_four + bic
 *   uk_sort_code → sort_code_last_four
 *
 * Backfill infers the scheme from the country, which is right for every row we have: US
 * accounts are ABA, GB accounts are sort code, everything else in our book is SEPA. It is not
 * right in general, which is why new accounts state their scheme explicitly.
 *
 * The default-account index is left alone here: `bank_account.livemode` does not exist yet
 * (migration 31 adds it), so `pix_bank_account_default` stays `(merchant_id, currency)` until
 * then and a test-mode default still competes with the live one for one more release.
 *
 * Three review rounds; osquash made me write the constraint out per scheme instead of the
 * clever `num_nonnulls()` version I had first, on the grounds that the error message from
 * this one tells you which field you missed.
 *
 * — ystackoverflow, month 12
 */
export class AddBankAccountSchemes1727700000000 implements MigrationInterface {
  name = 'AddBankAccountSchemes1727700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create type bank_account_scheme as enum ('aba', 'iban', 'uk_sort_code')`);

    await queryRunner.query(`alter table bank_account add column scheme bank_account_scheme`);
    await queryRunner.query(`alter table bank_account add column iban_last_four char(4)`);
    await queryRunner.query(`alter table bank_account add column bic varchar(11)`);
    await queryRunner.query(`alter table bank_account add column sort_code_last_four char(4)`);

    await queryRunner.query(`
      update bank_account
         set scheme = case
                        when country = 'US' then 'aba'::bank_account_scheme
                        when country = 'GB' then 'uk_sort_code'::bank_account_scheme
                        else 'iban'::bank_account_scheme
                      end
       where scheme is null
    `);

    // Rows that predate the scheme columns have a last_four and nothing rail-specific. Copy
    // it into the right column so the constraint below can be trusted rather than deferred.
    await queryRunner.query(`
      update bank_account set routing_last_four = coalesce(routing_last_four, last_four)
       where scheme = 'aba'
    `);
    await queryRunner.query(`
      update bank_account set sort_code_last_four = coalesce(sort_code_last_four, last_four)
       where scheme = 'uk_sort_code'
    `);
    await queryRunner.query(`
      update bank_account set iban_last_four = coalesce(iban_last_four, last_four),
                              bic = coalesce(bic, 'UNKNOWNXXX')
       where scheme = 'iban'
    `);

    await queryRunner.query(`alter table bank_account alter column scheme set not null`);

    await queryRunner.query(`
      alter table bank_account add constraint chk_bank_account_scheme_fields check (
        (scheme = 'aba' and routing_last_four is not null)
        or (scheme = 'iban' and iban_last_four is not null and bic is not null)
        or (scheme = 'uk_sort_code' and sort_code_last_four is not null)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table bank_account drop constraint if exists chk_bank_account_scheme_fields`,
    );
    await queryRunner.query(`alter table bank_account drop column if exists sort_code_last_four`);
    await queryRunner.query(`alter table bank_account drop column if exists bic`);
    await queryRunner.query(`alter table bank_account drop column if exists iban_last_four`);
    await queryRunner.query(`alter table bank_account drop column if exists scheme`);
    await queryRunner.query(`drop type if exists bank_account_scheme`);
  }
}
