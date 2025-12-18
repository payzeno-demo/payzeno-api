import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 21 (month 5) — `staff_user`, `staff_audit_log`, the `staff_role` enum.
 *
 * Splitting the platform operator out of the merchant's own `admin`. Until this landed,
 * `POST /v1/merchants/:id/status` was gated on `admin`, which meant a suspended merchant
 * could un-suspend itself with its own owner login. That is not a hypothetical: it is why
 * this migration was written in a hurry between two other pieces of work, which is also why
 * its timestamp sits between 10 and 11 rather than at the end of the chain.
 *
 * `staff_audit_log.staff_id` references `staff_user` with `on delete restrict`, so a staff
 * account is disabled and never deleted — the trail keeps its foreign key.
 *
 * — osquash, month 5
 */
export class AddStaffUsers1721700000000 implements MigrationInterface {
  name = 'AddStaffUsers1721700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create type staff_role as enum ('support', 'risk', 'finance', 'admin')`);

    await queryRunner.query(`
      create table staff_user (
        id text primary key,
        email citext not null,
        full_name text not null,
        password_hash text not null,
        role staff_role not null,
        mfa_enrolled boolean not null default false,
        last_login_at timestamptz,
        disabled_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`create unique index uq_staff_user_email on staff_user (email)`);
    await queryRunner.query(
      `create index pix_staff_user_active on staff_user (role) where disabled_at is null`,
    );
    await queryRunner.query(`
      create trigger staff_user_set_updated_at before update on staff_user
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table staff_audit_log (
        id text primary key,
        staff_id text not null references staff_user (id) on delete restrict,
        acting_merchant_id text,
        action text not null,
        resource_type text not null,
        resource_id text,
        before jsonb,
        after jsonb,
        reason text,
        request_id text,
        ip inet,
        created_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`
      create index ix_staff_audit_log_staff_created on staff_audit_log (staff_id, created_at desc)
    `);
    await queryRunner.query(`
      create index ix_staff_audit_log_merchant_created
        on staff_audit_log (acting_merchant_id, created_at desc)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists staff_audit_log`);
    await queryRunner.query(`drop table if exists staff_user`);
    await queryRunner.query(`drop type if exists staff_role`);
  }
}
