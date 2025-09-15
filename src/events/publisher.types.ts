/**
 * Internal types for the publish side of the bus.
 *
 * `types.ts` in @payzeno/contracts declares itself the exact export set of the package, so
 * none of these live there — see interfaces.md §2.5.
 */
import type { EventType } from '@payzeno/contracts/events';
import type { IsoTimestamp, MerchantId } from '@payzeno/contracts';

/**
 * Everything a publisher needs that is not the payload. Assembled by the caller — usually
 * from `RequestContext` (src/common/logging/request-context.ts) so `correlation_id`
 * survives the hop from the originating HTTP request into the envelope, which is what
 * events.ts requires.
 */
export interface PublishContext {
  merchantId: MerchantId | null;
  correlationId: string;
  causationId: string | null;
  livemode: boolean;
  occurredAt: IsoTimestamp;
}

/**
 * The SNS topic names frozen in events.ts. One topic per bounded context.
 *
 * Re-exported, not re-declared. This was a hand-written union of four string literals until
 * the day `payzeno-billing-events` was added upstream and payzeno-api kept compiling against
 * a set that no longer matched the infrastructure. `topics.ts` says "rename at your peril"
 * and it means it — the only safe way to name a topic here is to not name it here.
 */
/** What a single drain pass did. Surfaced in `JobResult` and in the drain log line. */
export interface DrainOutcome {
  claimed: number;
  published: number;
  failed: number;
  dead: number;
}

/**
 * Backoff for a failing outbox row: 2^attempt seconds with ±20% jitter, capped by
 * `OUTBOX_MAX_ATTEMPTS`. Without `next_attempt_at` a permanently failing event is
 * re-selected every 5 seconds forever (data-model.md §1.11).
 */
