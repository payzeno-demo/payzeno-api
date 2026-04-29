import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 25 — PAY-2052, INC hardening. `settlement_completion`.
 *
 * `settlement.completed` is the sole driver of `charge captured -> settled`. It is chunked at
 * 1000 charge ids and it crosses an at-least-once, explicitly unordered bus. Before this
 * table existed, a chunk lost to the DLQ stranded its charges `captured` with a null
 * `settlement_batch_id` forever and nothing anywhere knew a chunk was missing.
 *
 * Now `LedgerEventsConsumer` records each `chunk_index` in `chunks_seen` and marks the batch
 * complete only when every index `0..chunk_count-1` is present. `chunks_seen` is a set, so a
 * redelivered chunk is a no-op — which is what makes the accounting safe under at-least-once
 * rather than merely optimistic.
 *
 * `pix_settlement_completion_incomplete` is what the on-call dashboard queries: a completion
 * row older than a few hours with no `completed_at` is a lost chunk, and
 * `UnsettledChargeSweepJob` is the thing that repairs it.
 *
 * — osquash, month 9
 */
export class AddSettlementCompletion1725300000000 implements MigrationInterface {
  name = 'AddSettlementCompletion1725300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table settlement_completion (
        batch_id text not null,
        run_id text not null,
        chunk_count smallint not null,
        chunks_seen smallint[] not null default '{}',
        charges_marked integer not null default 0,
        completed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (batch_id, run_id)
      )
    `);

    await queryRunner.query(`
      create index pix_settlement_completion_incomplete on settlement_completion (created_at)
        where completed_at is null
    `);

    await queryRunner.query(`
      create trigger settlement_completion_set_updated_at before update on settlement_completion
        for each row execute function set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists settlement_completion`);
  }
}
