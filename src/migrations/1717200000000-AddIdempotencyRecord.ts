import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 03 — `idempotency_record`.
 *
 * The primary key is `(merchant_id, key)` today. Migration 23 widens it to include
 * `livemode`, because until then a test-mode request could replay a live-mode response for
 * the same key — see data-model.md §1.10 and docs/adr/0004-idempotency-storage.md.
 *
 * `fingerprint` is `sha256(method || path || canonical_json(body))`. Reusing a key with a
 * different body is `409 idempotency_key_reuse`, not a silent replay of the wrong response.
 *
 * — osquash, month 2
 */
export class AddIdempotencyRecord1717200000000 implements MigrationInterface {
  name = 'AddIdempotencyRecord1717200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `create type idempotency_state as enum ('in_progress', 'completed', 'failed')`,
    );

    await queryRunner.query(`
      create table idempotency_record (
        merchant_id text not null,
        key varchar(255) not null,
        fingerprint char(64) not null,
        state idempotency_state not null,
        response_status smallint,
        response_body jsonb,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        primary key (merchant_id, key)
      )
    `);

    await queryRunner.query(
      `create index ix_idempotency_record_expires on idempotency_record (expires_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists idempotency_record`);
    await queryRunner.query(`drop type if exists idempotency_state`);
  }
}
