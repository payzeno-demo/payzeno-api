import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 09 — `audit_log`.
 *
 * Append-only: no `updated_at`, no trigger, no update path in the repository. An audit row
 * that can be edited answers a different question from the one anyone is asking.
 *
 * `merchant_id` is nullable because a platform action has no tenant — creating a merchant,
 * or the ledger reporting a duplicate settlement for an orphaned reconciliation item that
 * resolves to no charge at all.
 *
 * `ip inet` rather than text: it is the type that rejects garbage and the type that supports
 * a subnet query when somebody asks "what else came from that range".
 *
 * — osquash, month 5
 */
export class AddAuditLog1720800000000 implements MigrationInterface {
  name = 'AddAuditLog1720800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create type audit_actor_type as enum ('user', 'api_key', 'staff', 'internal_service', 'system')
    `);

    await queryRunner.query(`
      create table audit_log (
        id text primary key,
        merchant_id text,
        actor_type audit_actor_type not null,
        actor_id text,
        action text not null,
        resource_type text not null,
        resource_id text,
        before jsonb,
        after jsonb,
        request_id text,
        ip inet,
        created_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`
      create index ix_audit_log_merchant_created on audit_log (merchant_id, created_at desc)
    `);
    await queryRunner.query(
      `create index ix_audit_log_resource on audit_log (resource_type, resource_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists audit_log`);
    await queryRunner.query(`drop type if exists audit_actor_type`);
  }
}
