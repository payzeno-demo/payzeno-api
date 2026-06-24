import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 18 — `ix_webhook_event_type`.
 *
 * The console's webhook log has a type filter, and it was scanning the whole table for every
 * "show me just the payout.failed ones" click. One index, one column.
 *
 * My first migration. Four review rounds, mostly about things I would not have thought of:
 *  - build it CONCURRENTLY, so the table is not locked while it builds on a live database;
 *  - `if not exists` on both sides, so a half-applied deploy can be re-run;
 *  - a `down()` that actually drops it, because "we would never roll back an index" is how
 *    you find out that you would.
 *
 * — ystackoverflow, month 10
 */
export class AddWebhookEventTypeIndex1726200000000 implements MigrationInterface {
  name = 'AddWebhookEventTypeIndex1726200000000';

  /**
   * `create index concurrently` cannot run inside a transaction block, and typeorm wraps
   * every migration in one unless you say this.
   */
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create index concurrently if not exists ix_webhook_event_type on webhook_event (type)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index concurrently if exists ix_webhook_event_type`);
  }
}
