import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RFC platform-v2 §3-§4 — `merchant_user_token`, the single-use secrets behind every emailed
 * link that lets a person back in: signup verification, team invitation, password reset.
 *
 * Only the SHA-256 of the secret is stored. The plaintext exists in exactly two places, the
 * email that carried it and the browser that clicks it; a read of this table cannot be turned
 * into a login. `uq_merchant_user_token_hash` is the lookup, and also what makes a collision
 * fail loudly instead of resolving to someone else's row.
 *
 * Consumption is a conditional UPDATE (`consumed_at is null and expires_at > :now`), so two
 * clicks on the same link race to one winner. `pix_merchant_user_token_live` is what the
 * "issuing a new reset link revokes the old one" UPDATE scans.
 */
export class AddMerchantUserTokens1731100000000 implements MigrationInterface {
  name = 'AddMerchantUserTokens1731100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table merchant_user_token (
        id text primary key,
        purpose text not null,
        token_hash text not null,
        merchant_id text not null references merchant (id) on delete restrict,
        user_id text not null references merchant_user (id) on delete restrict,
        expires_at timestamptz not null,
        consumed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_merchant_user_token_purpose
          check (purpose in ('email_verification', 'invitation', 'password_reset'))
      )
    `);
    await queryRunner.query(
      `create unique index uq_merchant_user_token_hash on merchant_user_token (token_hash)`,
    );
    await queryRunner.query(`
      create index pix_merchant_user_token_live on merchant_user_token (user_id, purpose)
        where consumed_at is null
    `);
    await queryRunner.query(`
      create trigger merchant_user_token_set_updated_at before update on merchant_user_token
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists merchant_user_token`);
  }
}
