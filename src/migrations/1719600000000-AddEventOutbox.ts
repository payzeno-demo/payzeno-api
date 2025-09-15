import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 07 — `event_outbox` and `processed_event`. The bus becomes real here.
 *
 * Read docs/adr/0011-outbox-over-direct-publish.md before touching either table.
 *
 * `pix_event_outbox_due` is a partial index over `next_attempt_at`. Both halves matter:
 * without `next_attempt_at` a permanently failing row is re-selected every five seconds
 * forever, and without the partial predicate the index grows with every event we have ever
 * published rather than with the ones still owed.
 *
 * `processed_event`'s primary key is `event_id` alone in this version. Migration 26 widens it
 * to `(event_id, consumer)` — payzeno-api has two consumers whose handled sets overlap, and
 * with `event_id` alone the DLQ consumer can never mark anything processed.
 *
 * — dhotfix, month 4
 */
export class AddEventOutbox1719600000000 implements MigrationInterface {
  name = 'AddEventOutbox1719600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table event_outbox (
        id text primary key,
        type text not null,
        version smallint not null,
        payload jsonb not null,
        merchant_id text,
        correlation_id text not null,
        causation_id text,
        livemode boolean not null,
        occurred_at timestamptz not null,
        published_at timestamptz,
        attempt_count smallint not null default 0,
        next_attempt_at timestamptz not null default now(),
        claimed_at timestamptz,
        claimed_by text,
        dead_at timestamptz,
        last_error text,
        created_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`
      create index pix_event_outbox_due on event_outbox (next_attempt_at)
        where published_at is null and dead_at is null
    `);

    await queryRunner.query(`
      create table processed_event (
        event_id text primary key,
        consumer text not null,
        processed_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(
      `create index ix_processed_event_processed_at on processed_event (processed_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists processed_event`);
    await queryRunner.query(`drop table if exists event_outbox`);
  }
}
