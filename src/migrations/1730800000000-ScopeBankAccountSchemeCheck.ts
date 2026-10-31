import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 36 — `chk_bank_account_scheme_fields` applies once an account has left `new`.
 *
 * `POST /v1/bank_accounts` receives a `bat_` token and nothing else (CreateBankAccountRequest
 * has no rail fields, and the vault answers a bank tokenisation with `last_four` only). The
 * per-scheme last-four columns and the BIC arrive with validation. BankAccountsService.build
 * says exactly that and writes them null, so under migration 29's unconditional check EVERY
 * create failed with a 23514 — no merchant could add a bank account at all.
 *
 * The rule migration 29 states is still the rule for an account Payzeno will pay out to: a
 * `validated` (or failed / errored) row must carry its scheme's fields. Only the row that is
 * still waiting on validation is exempt. Every existing row satisfied the old, stricter check,
 * so this cannot invalidate anything.
 */
export class ScopeBankAccountSchemeCheck1730800000000 implements MigrationInterface {
  name = 'ScopeBankAccountSchemeCheck1730800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table bank_account drop constraint chk_bank_account_scheme_fields`);
    await queryRunner.query(`
      alter table bank_account add constraint chk_bank_account_scheme_fields check (
        status = 'new'
        or (scheme = 'aba' and routing_last_four is not null)
        or (scheme = 'iban' and iban_last_four is not null and bic is not null)
        or (scheme = 'uk_sort_code' and sort_code_last_four is not null)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Fails if a `new` row without rail fields exists — which is the point of going down.
    await queryRunner.query(`alter table bank_account drop constraint chk_bank_account_scheme_fields`);
    await queryRunner.query(`
      alter table bank_account add constraint chk_bank_account_scheme_fields check (
        (scheme = 'aba' and routing_last_four is not null)
        or (scheme = 'iban' and iban_last_four is not null and bic is not null)
        or (scheme = 'uk_sort_code' and sort_code_last_four is not null)
      )
    `);
  }
}
