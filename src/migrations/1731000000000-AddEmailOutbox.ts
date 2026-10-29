import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RFC platform-v2 §2 — `email_outbox`, the one table every email Payzeno sends passes through.
 *
 * `EmailService.queue` inserts a row inside the caller's transaction, so an email exists if and
 * only if the business change that caused it committed; `EmailDeliveryJob` renders and sends.
 * The same shape as `event_outbox` and for the same reason (ADR 0011): a send from inside a
 * request handler is a send for a transaction that may still roll back.
 *
 * `pix_email_outbox_due` is the delivery job's claim; `ix_email_outbox_to_created` is support's
 * "did we email them?" lookup (`GET /v1/admin/emails?to=`). `to_address` is citext so that
 * lookup does not care how the merchant capitalised their address.
 *
 * `subject` is rendered at queue time so the admin lookup can show it before the message is
 * sent; the bodies are rendered at send time from `data` and never stored.
 */
export class AddEmailOutbox1731000000000 implements MigrationInterface {
  name = 'AddEmailOutbox1731000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table email_outbox (
        id text primary key,
        template text not null,
        to_address citext not null,
        subject text not null,
        data jsonb not null default '{}'::jsonb,
        merchant_id text references merchant (id) on delete restrict,
        livemode boolean not null default true,
        status text not null default 'queued',
        attempt_count integer not null default 0,
        next_attempt_at timestamptz not null,
        last_error text,
        provider_message_id text,
        sent_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_email_outbox_status check (status in ('queued', 'sent', 'failed'))
      )
    `);
    await queryRunner.query(
      `create index pix_email_outbox_due on email_outbox (next_attempt_at) where status = 'queued'`,
    );
    await queryRunner.query(
      `create index ix_email_outbox_to_created on email_outbox (to_address, created_at desc)`,
    );
    await queryRunner.query(
      `create index ix_email_outbox_merchant_created on email_outbox (merchant_id, created_at desc)`,
    );
    await queryRunner.query(`
      create trigger email_outbox_set_updated_at before update on email_outbox
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists email_outbox`);
  }
}
