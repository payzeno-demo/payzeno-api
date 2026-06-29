import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 27 — `webhook_event.source_event_id` and `uq_webhook_event_source`.
 *
 * `WebhookFanoutConsumer` is the only writer of `webhook_event`, and it writes one row per
 * endpoint per bus event. The bus is at-least-once. Without a dedupe key, a redelivered
 * `payout.failed` sent the merchant a second webhook — and merchants build ledgers off our
 * webhooks, so a second one is a second row in somebody's accounts.
 *
 * `source_event_id` is the `EventEnvelope.id` the row was fanned out from, and
 * `uq_webhook_event_source (endpoint_id, source_event_id)` is what the fanout inserts
 * `ON CONFLICT DO NOTHING` against.
 *
 * Backfill uses the row's own id for historic rows: they predate the concept, they are all
 * long delivered, and a self-referential value is unique by construction so the index can be
 * built without inventing a fake envelope id that a future event might collide with.
 *
 * — ytechdebt, month 10
 */
export class AddWebhookEventSourceId1726500000000 implements MigrationInterface {
  name = 'AddWebhookEventSourceId1726500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table webhook_event add column source_event_id text`);

    await queryRunner.query(`
      update webhook_event set source_event_id = id where source_event_id is null
    `);

    await queryRunner.query(`alter table webhook_event alter column source_event_id set not null`);

    await queryRunner.query(`
      create unique index uq_webhook_event_source on webhook_event (endpoint_id, source_event_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists uq_webhook_event_source`);
    await queryRunner.query(`alter table webhook_event drop column if exists source_event_id`);
  }
}
