import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 24 (month 8) — envelope encryption for webhook signing secrets.
 *
 * `webhook_endpoint.signing_secret_hash` was a mistake and this is the fix. Outbound signing
 * is `HMAC-SHA256(secret, "{t}.{body}")`, and you cannot compute an HMAC from a hash of the
 * key — the column made merchant webhook signing literally unimplementable, which is why
 * `signature_version` sat at 'v1' with nothing verifying it.
 *
 * Now: `signing_secret_encrypted bytea`, envelope-encrypted under `WEBHOOK_SIGNING_KEK`, plus
 * `signing_secret_previous_encrypted` and `rotated_at` so a rotation has an overlap window
 * during which we send both signatures and the merchant can verify against either.
 *
 * The old column is NOT dropped here. Two-phase: `WebhookSecretService` stops reading it in
 * this release and migration 25+ was supposed to drop it "one release later". It is month 12
 * and `readLegacySigningSecretHash()` is still in the tree.
 *
 * — osquash, month 8
 */
export class AddWebhookSecretEncryption1724700000000 implements MigrationInterface {
  name = 'AddWebhookSecretEncryption1724700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table webhook_endpoint add column signing_secret_encrypted bytea`);
    await queryRunner.query(
      `alter table webhook_endpoint add column signing_secret_previous_encrypted bytea`,
    );
    await queryRunner.query(`alter table webhook_endpoint add column signing_secret_last_four char(4)`);
    await queryRunner.query(`alter table webhook_endpoint add column rotated_at timestamptz`);

    // Endpoints created before this release have a hash and no recoverable secret. They are
    // marked so the console prompts for a rotation; until the merchant rotates, delivery
    // signs with a freshly minted secret and the endpoint's last four is blank.
    await queryRunner.query(`
      update webhook_endpoint
         set signing_secret_last_four = '0000'
       where signing_secret_last_four is null
    `);

    await queryRunner.query(
      `alter table webhook_endpoint alter column signing_secret_last_four set not null`,
    );
    await queryRunner.query(`alter table webhook_endpoint alter column signing_secret_hash drop not null`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table webhook_endpoint drop column if exists rotated_at`);
    await queryRunner.query(
      `alter table webhook_endpoint drop column if exists signing_secret_last_four`,
    );
    await queryRunner.query(
      `alter table webhook_endpoint drop column if exists signing_secret_previous_encrypted`,
    );
    await queryRunner.query(
      `alter table webhook_endpoint drop column if exists signing_secret_encrypted`,
    );
  }
}
