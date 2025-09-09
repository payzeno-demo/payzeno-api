import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 06 — `webhook_endpoint` and `webhook_event`.
 *
 * The signing secret is stored as a HASH in this version, which is wrong and was found out
 * the hard way: you cannot compute `HMAC-SHA256(secret, body)` from a hash of the secret, so
 * outbound signing was unimplementable until migration 24 replaced it with envelope
 * encryption under `WEBHOOK_SIGNING_KEK`. This migration is left exactly as it shipped.
 *
 * `pix_webhook_event_due` is the index `WebhookDeliveryJob` rides. `source_event_id` and its
 * unique index arrive in migration 27 — until then a redelivered bus event genuinely did
 * send the merchant a second webhook.
 *
 * — osquash, month 3
 */
export class AddWebhooks1719000000000 implements MigrationInterface {
  name = 'AddWebhooks1719000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`create type webhook_endpoint_status as enum ('enabled', 'disabled')`);
    await queryRunner.query(`
      create type webhook_event_status as enum ('pending', 'delivering', 'delivered', 'dead')
    `);

    await queryRunner.query(`
      create table webhook_endpoint (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        url text not null,
        enabled_events text[] not null default '{}',
        signing_secret_hash text not null,
        status webhook_endpoint_status not null default 'enabled',
        consecutive_failure_count integer not null default 0,
        last_success_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(
      `create index ix_webhook_endpoint_merchant_id on webhook_endpoint (merchant_id)`,
    );
    await queryRunner.query(`
      create trigger webhook_endpoint_set_updated_at before update on webhook_endpoint
        for each row execute function set_updated_at()
    `);

    await queryRunner.query(`
      create table webhook_event (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        endpoint_id text not null references webhook_endpoint (id) on delete restrict,
        type text not null,
        payload jsonb not null,
        status webhook_event_status not null default 'pending',
        attempt_count smallint not null default 0,
        next_attempt_at timestamptz,
        last_response_status smallint,
        last_error text,
        signature_version varchar(4) not null default 'v1',
        delivered_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await queryRunner.query(`
      create index pix_webhook_event_due on webhook_event (next_attempt_at)
        where status = 'pending'
    `);
    await queryRunner.query(`
      create index ix_webhook_event_merchant_created on webhook_event (merchant_id, created_at desc)
    `);
    await queryRunner.query(`
      create trigger webhook_event_set_updated_at before update on webhook_event
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists webhook_event`);
    await queryRunner.query(`drop table if exists webhook_endpoint`);
    await queryRunner.query(`drop type if exists webhook_event_status`);
    await queryRunner.query(`drop type if exists webhook_endpoint_status`);
  }
}
