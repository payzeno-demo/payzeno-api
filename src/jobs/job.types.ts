/**
 * Shared vocabulary for the nine scheduled jobs.
 *
 * Every job returns a `JobResult` and every job's result is logged at the same key
 * (`job.finished`), which is what makes the CloudWatch metric filters in
 * payzeno-infrastructure a single expression instead of nine. If you add a field here, add it
 * to docs/runbooks/payzeno-api.md at the same time — apager.
 */
import type { IsoTimestamp } from '@payzeno/contracts';

export interface JobResult {
  /** Rows/messages the run actually touched. */
  processed: number;
  /** Of those, how many the job could not complete. Non-zero is not necessarily an alarm. */
  failed: number;
  /** True when the run hit its per-run cap and there is more work waiting. */
  truncated: boolean;
  durationMs: number;
  /** Free-form, flat scalars only — this goes straight into a log line. */
  details?: Record<string, string | number | boolean | null>;
}

export const SKIPPED_NOT_LEADER: JobResult = {
  processed: 0,
  failed: 0,
  truncated: false,
  durationMs: 0,
  details: { skipped: 'lock_not_acquired' },
};

export function backoffMs(attempt: number, baseMs = 1_000, capMs = 6 * 3_600_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.round(exponential + jitter));
}

export function summarise(result: JobResult): Record<string, string | number | boolean | null> {
  return {
    processed: result.processed,
    failed: result.failed,
    truncated: result.truncated,
    duration_ms: result.durationMs,
    ...(result.details ?? {}),
  };
}
