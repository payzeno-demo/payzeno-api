import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RFC platform-v2 §3 — `merchant_onboarding` (one row per merchant: the KYC state machine, the
 * business profile and the representative) and `kyc_document` (metadata only; the bytes live
 * in the private S3 bucket under `storage_key`).
 *
 * The profile and the representative are jsonb rather than columns: they are read and written
 * whole, nothing queries into them, and the field list is the contract's (`BusinessProfile`,
 * `Representative`) — a column per field would be a migration per field the risk team asks for.
 *
 * Backfill, in the same migration because the new code reads the row for every merchant: a
 * merchant that is already trading was onboarded by hand, so its row is `approved`; a rejected
 * one is `rejected`; a `pending_review` one starts `collecting`. Additive-then-backfill, and
 * safe against the running code, which does not know the table exists.
 */
export class AddMerchantOnboarding1731200000000 implements MigrationInterface {
  name = 'AddMerchantOnboarding1731200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table merchant_onboarding (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        state text not null default 'collecting',
        business_profile jsonb not null default '{}'::jsonb,
        representative jsonb not null default '{}'::jsonb,
        staff_message text,
        submitted_at timestamptz,
        decided_at timestamptz,
        decided_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_merchant_onboarding_state
          check (state in ('collecting', 'submitted', 'needs_info', 'approved', 'rejected'))
      )
    `);
    await queryRunner.query(
      `create unique index uq_merchant_onboarding_merchant on merchant_onboarding (merchant_id)`,
    );
    await queryRunner.query(
      `create index ix_merchant_onboarding_state_submitted on merchant_onboarding (state, submitted_at)`,
    );
    await queryRunner.query(`
      create trigger merchant_onboarding_set_updated_at before update on merchant_onboarding
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table kyc_document (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        type text not null,
        filename text not null,
        content_type text not null,
        size_bytes integer not null,
        sha256 text not null,
        storage_key text not null,
        uploaded_by text,
        created_at timestamptz not null default now(),
        constraint chk_kyc_document_type check (
          type in ('identity_document', 'proof_of_address', 'company_registration', 'bank_statement')
        ),
        constraint chk_kyc_document_size check (size_bytes > 0 and size_bytes <= 614400)
      )
    `);
    await queryRunner.query(
      `create index ix_kyc_document_merchant_created on kyc_document (merchant_id, created_at desc)`,
    );

    // The backfill. `'onb_' || substr(id, 5)` reuses the merchant's ULID body: unique because
    // the merchant id is, time-ordered because it is, and no extension needed to mint one.
    await queryRunner.query(`
      insert into merchant_onboarding (id, merchant_id, state, decided_at, created_at, updated_at)
      select 'onb_' || substr(m.id, 5),
             m.id,
             case
               when m.status in ('active', 'restricted', 'suspended', 'closed') then 'approved'
               when m.status = 'rejected' then 'rejected'
               else 'collecting'
             end,
             case when m.status = 'pending_review' then null else m.updated_at end,
             m.created_at,
             m.created_at
        from merchant m
       where not exists (select 1 from merchant_onboarding o where o.merchant_id = m.id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists kyc_document`);
    await queryRunner.query(`drop table if exists merchant_onboarding`);
  }
}
