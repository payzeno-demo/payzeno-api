import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 23 (month 8) — `idempotency_record.lease_expires_at`, and the primary key widened to
 * `(merchant_id, livemode, key)`.
 *
 * Two bugs in one migration, both found the same week:
 *
 *  1. A process that died mid-request left its row `in_progress` forever, and the merchant
 *     got `409 idempotency_in_progress` for that key for a full 24 hours. `lease_expires_at`
 *     is the crash-recovery mechanism — a row past its lease is reclaimable by the next
 *     request, and `IdempotencyRetentionJob` sweeps the rest.
 *  2. `livemode` was not in the key, so a test-mode request could replay a live-mode
 *     response. The keys are chosen by the merchant's own client library and collide across
 *     modes routinely.
 *
 * The default of `created_at + 60s` for existing rows is arbitrary and safe: every row that
 * old is either completed (lease irrelevant) or abandoned (should be reclaimable).
 *
 * — ytechdebt, month 8
 */
export class AddIdempotencyLease1724100000000 implements MigrationInterface {
  name = 'AddIdempotencyLease1724100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table idempotency_record add column lease_expires_at timestamptz`);
    await queryRunner.query(`
      update idempotency_record set lease_expires_at = created_at + interval '60 seconds'
       where lease_expires_at is null
    `);
    await queryRunner.query(
      `alter table idempotency_record alter column lease_expires_at set not null`,
    );

    await queryRunner.query(
      `alter table idempotency_record add column livemode boolean not null default true`,
    );

    await queryRunner.query(`alter table idempotency_record drop constraint idempotency_record_pkey`);
    await queryRunner.query(`
      alter table idempotency_record
        add constraint idempotency_record_pkey primary key (merchant_id, livemode, key)
    `);

    await queryRunner.query(`
      create index pix_idempotency_record_stale_lease on idempotency_record (lease_expires_at)
        where state = 'in_progress'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists pix_idempotency_record_stale_lease`);
    await queryRunner.query(`alter table idempotency_record drop constraint idempotency_record_pkey`);
    await queryRunner.query(`
      alter table idempotency_record
        add constraint idempotency_record_pkey primary key (merchant_id, key)
    `);
    await queryRunner.query(`alter table idempotency_record drop column if exists livemode`);
    await queryRunner.query(`alter table idempotency_record drop column if exists lease_expires_at`);
  }
}
