import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ReconciliationRunId, SettlementBatchId } from '@payzeno/contracts';

/**
 * `settlement_completion` — data-model.md §1.15, migration 25, PAY-2052.
 *
 * Added during the arc-INC hardening. `settlement.completed` is chunked at 1000 charges and
 * is the SOLE driver of `charge captured -> settled`, over an at-least-once, explicitly
 * unordered bus. A chunk lost to the DLQ strands those charges `captured` with a null
 * `settlement_batch_id` forever, and nothing notices.
 *
 * `LedgerEventsConsumer` records each `chunk_index` here and marks the batch complete only
 * when every index 0..chunk_count-1 is present. `UnsettledChargeSweepJob` (PAY-2058) picks
 * up whatever is still missing six hours later.
 */
@Entity({ name: 'settlement_completion' })
@Index('pix_settlement_completion_incomplete', ['createdAt'], {
  where: 'completed_at is null',
})
export class SettlementCompletion {
  @PrimaryColumn({ name: 'batch_id', type: 'text' })
  batchId!: SettlementBatchId;

  /**
   * A re-run of reconciliation against the same batch emits a fresh set of chunks. Keying
   * on batch alone would make the second run look like duplicate chunks of the first.
   */
  @PrimaryColumn({ name: 'run_id', type: 'text' })
  runId!: ReconciliationRunId;

  @Column({ name: 'chunk_count', type: 'smallint' })
  chunkCount!: number;

  /** Postgres `smallint[]`. Sorted is not guaranteed — the bus is unordered. */
  @Column({ name: 'chunks_seen', type: 'smallint', array: true, default: () => "'{}'" })
  chunksSeen!: number[];

  @Column({ name: 'charges_marked', type: 'integer', default: 0 })
  chargesMarked!: number;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  /** Every index in 0..chunkCount-1 has arrived. */
  hasAllChunks(): boolean {
    if (this.chunkCount <= 0) {
      return false;
    }
    const seen = new Set(this.chunksSeen);
    for (let i = 0; i < this.chunkCount; i += 1) {
      if (!seen.has(i)) {
        return false;
      }
    }
    return true;
  }

  /** The chunk indices we are still waiting on. Logged by the sweep job when it alarms. */
  missingChunks(): number[] {
    const seen = new Set(this.chunksSeen);
    const missing: number[] = [];
    for (let i = 0; i < this.chunkCount; i += 1) {
      if (!seen.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }
}
