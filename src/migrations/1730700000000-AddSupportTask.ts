import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 35 — `support_task`, which `SupportTaskEntity` and `SupportTasksService` have described since
 * arc INC without any migration ever creating it. `POST /internal/v1/support-tasks` and the
 * two LedgerEventsConsumer branches that open a task both failed on "relation does not exist",
 * and the consumer's failure sent each of those events round the redrive loop into the DLQ.
 *
 * The shape is the entity's, column for column. `uq_support_task_source_event` is the partial
 * unique index `SupportTasksService.open` relies on for `ON CONFLICT DO NOTHING`: a redelivered
 * bus event must be a no-op, not a second task (PAY-2053).
 */
export class AddSupportTask1730700000000 implements MigrationInterface {
  name = 'AddSupportTask1730700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists support_task (
        id text primary key,
        merchant_id text not null references merchant (id) on delete restrict,
        livemode boolean not null,
        kind text not null,
        severity text not null default 'normal',
        status text not null default 'open',
        charge_id text,
        title text not null,
        body text not null,
        source_event_id text,
        assigned_to text,
        resolved_at timestamptz,
        resolution_note text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint chk_support_task_severity check (severity in ('low', 'normal', 'high', 'critical')),
        constraint chk_support_task_status check (status in ('open', 'acknowledged', 'resolved', 'dismissed'))
      )
    `);
    await queryRunner.query(
      `create index if not exists ix_support_task_merchant_created on support_task (merchant_id, created_at desc)`,
    );
    await queryRunner.query(
      `create index if not exists ix_support_task_status_severity on support_task (status, severity)`,
    );
    await queryRunner.query(`
      create unique index if not exists uq_support_task_source_event on support_task (kind, source_event_id)
        where source_event_id is not null
    `);
    await queryRunner.query(`
      create trigger support_task_set_updated_at before update on support_task
        for each row execute function set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists support_task`);
  }
}
