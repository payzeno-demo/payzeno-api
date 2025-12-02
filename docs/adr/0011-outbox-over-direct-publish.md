# ADR 0011 — Transactional outbox, not direct publish

- **Status:** accepted
- **Date:** month 5
- **Author:** dhotfix
- **Implements:** migration 07 (`event_outbox`, `processed_event`), `src/events/`, `OutboxDrainJob`
- **Related:** [0009](0009-event-consumer-wiring.md)

## Context

`merchant.updated` is the only propagation path for `capture_at_settlement`. If that event is
lost, the ledger's view of the merchant diverges from ours, and the divergence is invisible
until a settlement runs. `payment.captured` is worse: the ledger posts from it, so a lost
`payment.captured` is money that moved without a journal entry.

Both of those had already happened by month 5, in the two ways they happen:

1. A direct `sns.publish()` inside a transaction that later rolled back. The event fired for a
   charge that does not exist.
2. A direct `sns.publish()` after a transaction committed, which failed. The charge exists; the
   ledger never heard about it.

There is no ordering of "commit" and "publish" that avoids both. That is the dual-write problem
and it does not have a clever solution.

## Decision

**Two `EventPublisher` implementations, and business code may only inject one of them.**

| Implementation | Writes to | Injected by |
|---|---|---|
| `OutboxEventPublisher` | `event_outbox`, **inside the caller's transaction** | every business service |
| `SnsEventPublisher` | SNS | `OutboxDrainJob` only |

`OutboxEventPublisher.publish()` takes the caller's `EntityManager`. The row and the business
write commit or roll back together, atomically, because they are the same transaction. There is
no window.

`OutboxDrainJob` runs every 5 seconds under a 30-second `@JobLock`, claims a batch of undrained
rows, and hands them to `SnsEventPublisher`. It is at-least-once by construction: a row is only
marked drained after SNS acknowledges, so a crash between publish and mark produces a duplicate,
never a loss.

### Two rules that follow, and are enforced in `TransactionManager`

1. **A transaction that publishes must pass its `EntityManager` down.** `TransactionManager.runInTransaction(cb)`
   hands the callback the manager; anything that writes inside must use it. A repository call
   that quietly opens its own connection is outside the transaction and defeats the whole thing.
2. **No I/O to another service inside a transaction, except the outbox write.** The one
   exception is `MerchantOnboardingService`, which calls `LedgerHttpClient.bootstrapAccounts()`
   inside the onboarding transaction. That is a deliberate, documented exception: bootstrap is
   idempotent on the ledger side and an orphaned merchant with no ledger accounts is worse than
   a held transaction. Nothing else gets that exception.

### The consumer side: at-least-once means dedupe is the consumer's job

`BaseEventConsumer.claimEvent()` inserts into `processed_event` **first**, before running the
handler:

```sql
INSERT INTO processed_event (event_id, consumer, ...) VALUES (...) ON CONFLICT DO NOTHING
```

Zero rows affected means somebody already has it; the message is deleted and the handler never
runs. Insert-first rather than handle-then-record is the important part: the reverse ordering
has a window where a crash after the side effect and before the record replays the side effect.

Migration 26 widened `processed_event`'s primary key from `event_id` to `(event_id, consumer)`,
because two consumers legitimately process the same event and the narrow key made the second one
a silent no-op.

## Consequences

- Publishing is not synchronous. `payment.captured` reaches the ledger in a few seconds, not a
  few milliseconds. Everything downstream is built for that and the SLO is stated in the runbook.
- `event_outbox` is a hot table. It is drained aggressively and `ProcessedEventRetentionJob`
  keeps `processed_event` bounded.
- On drain failure the row is not deleted and not retried in line: `markFailed` pushes
  `next_attempt_at` out exponentially and tombstones at attempt 12. A tombstoned row is a page.
- A raw `SnsEventPublisher` injection in a business service is a review rejection. There is one
  legitimate injection site and it is `OutboxDrainJob`.
