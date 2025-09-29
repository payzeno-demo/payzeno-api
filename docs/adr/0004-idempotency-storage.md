# ADR 0004 — Where idempotency records live, and what `begin()` must guarantee

- **Status:** accepted
- **Date:** month 2
- **Author:** osquash
- **Related:** migrations 03 and 23, `src/common/idempotency/`, `docs/runbooks/idempotency-and-replays.md`

## Context

Every mutating public route in this API accepts an `Idempotency-Key`. A merchant's retry after
a socket timeout must not create a second charge. That is the whole requirement, and it is the
one requirement where getting it 99% right is indistinguishable from getting it wrong, because
the 1% is somebody's card charged twice.

Two storage options were on the table: Postgres, in the same database and therefore the same
transaction as the business write; or Redis, which is faster and already deployed.

## Decision

**Both, behind `IdempotencyStore`, with Postgres as the default.**

`IDEMPOTENCY_BACKEND` selects the implementation. Postgres is the default and is what runs for
every route except `POST /v1/payment_intents`, which uses Redis because it is the highest-volume
mutating route we have and the record does not need to be transactional with anything.

The interface is three methods, and only one of them is interesting:

```ts
begin(key: IdempotencyKey): Promise<BeginResult>   // claim-or-report, atomic
complete(key, response): Promise<void>
fail(key): Promise<void>
```

### `begin()` is claim-or-report, never check-then-insert

This is the entire ADR in one line. A `SELECT` followed by an `INSERT` is two statements with a
window between them, and under a merchant's own concurrent retry that window is where the second
charge is created. Both implementations do it as a single conditional write:

- **Postgres:** `INSERT … ON CONFLICT (merchant_id, livemode, key) DO UPDATE … WHERE` — the
  `WHERE` clause is what reclaims an expired lease, so the update only fires for a record whose
  `lease_expires_at` has passed. The row returned tells the caller whether it claimed or lost.
- **Redis:** `SET NX PX` for the claim, plus a Lua script for the compare-and-reclaim, because
  the reclaim is itself a check-then-act and cannot be two round trips.

### What is in the key hash

The stored key is a hash over `(merchant_id, livemode, idempotency_key, method, path,
canonical_json(body))`.

Method and path are in the hash deliberately. Without them, an HTTP client that attaches one
key to a whole request chain gets undefined behaviour across two endpoints, and the endpoint
that wins is whichever landed first. With them, the second endpoint simply sees a fresh key.

The body is in the hash so that reusing a key with a *different* body is a `409
idempotency_key_reuse` rather than a silent replay of the wrong response. That is
`IdempotencyKeyReuseException`.

### `livemode` in the primary key

Migration 03 keyed the table `(merchant_id, key)`. That was wrong: a test-mode request could
replay a live-mode response for the same key, because merchants pick keys like `order-1041` in
both modes. Migration 23 widened the primary key to `(merchant_id, livemode, key)` and
backfilled `livemode = true`, which was correct because test-mode traffic in month 8 was
negligible and the alternative was a two-phase key rotation for nine rows.

## The known wart

The two stores compute `Retry-After` on an in-progress collision differently. Postgres derives
it from `lease_expires_at - now()`; Redis derives it from the remaining TTL, which is the lease
plus whatever is left of the SET's own expiry. They differ by up to a second. One spec asserts
each separately, which is how we know. It is a real bug, nobody has filed it, and it has never
mattered because clients round.

## Consequences

- A `409 idempotency_in_progress` is a normal, expected response with a `Retry-After`. It is
  not an error budget event and the runbook says so.
- `IdempotencyRetentionJob` deletes records past `IDEMPOTENCY_TTL_HOURS`. The lease reclaim path
  and the retention path are separate on purpose: a stuck lease should be reclaimed in seconds,
  a completed record should live for a day.
- The interceptor, not the service, owns all of this. A service never sees an idempotency key.
