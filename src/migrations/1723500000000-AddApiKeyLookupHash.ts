import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 22 (month 7) — `api_key.lookup_hash`, `uq_api_key_lookup_hash`, and the removal of
 * `uq_api_key_secret_hash`.
 *
 * Two hashes, on purpose. The token is `sk_live_<suffix>_<secret>`:
 *
 *   lookup_hash  HMAC-SHA256(secret, API_KEY_PEPPER). Deterministic, uniquely indexed, gives
 *                ApiKeyResolver an O(1) lookup.
 *   secret_hash  argon2id, salted, for the constant-time verify.
 *
 * A unique index on a salted argon2id hash is meaningless — the salt makes every row's digest
 * different for the same input — and the only alternative is argon2-verifying every row in
 * the table until one matches, which is not an authentication design. `uq_api_key_secret_hash`
 * therefore goes.
 *
 * The backfill can only populate `prefix`. `lookup_hash` cannot be derived from an argon2
 * digest, so existing keys are marked with a sentinel and re-issued: every affected merchant
 * was mailed, and the sentinel makes an un-rotated key fail closed rather than resolve to
 * somebody else's row.
 *
 * — dhotfix, month 7
 */
export class AddApiKeyLookupHash1723500000000 implements MigrationInterface {
  name = 'AddApiKeyLookupHash1723500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table api_key add column lookup_hash char(64)`);

    // A digest nothing can produce: the 'x' padding is not valid hex, so no presented token
    // can ever hash to it, and the md5 of the row id keeps it unique under the index below.
    // An un-rotated key fails closed.
    await queryRunner.query(`
      update api_key
         set lookup_hash = repeat('x', 32) || md5(id)
       where lookup_hash is null
    `);

    await queryRunner.query(`
      update api_key
         set prefix = case when mode = 'live' then 'sk_live_' else 'sk_test_' end
       where prefix is null or prefix = ''
    `);

    await queryRunner.query(`alter table api_key alter column lookup_hash set not null`);
    await queryRunner.query(`create unique index uq_api_key_lookup_hash on api_key (lookup_hash)`);
    await queryRunner.query(`drop index if exists uq_api_key_secret_hash`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create unique index uq_api_key_secret_hash on api_key (secret_hash)`);
    await queryRunner.query(`drop index if exists uq_api_key_lookup_hash`);
    await queryRunner.query(`alter table api_key drop column if exists lookup_hash`);
  }
}
