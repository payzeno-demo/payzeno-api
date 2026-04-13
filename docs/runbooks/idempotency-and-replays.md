# Runbook — idempotency and replays

Owner: osquash. Code: `src/common/idempotency/`. Design: `docs/adr/0004-idempotency-storage.md`.

---

## 1. The three responses, and which of them are normal

| Situation | Response | Normal? |
|---|---|---|
| First use of a key | the real response, recorded | yes |
| Same key, same body, request already completed | the **recorded** response, byte for byte | yes — this is the point |
| Same key, same body, request still in flight | `409 idempotency_in_progress` + `Retry-After` | yes |
| Same key, **different** body | `409 idempotency_key_reuse` | merchant bug |

`409 idempotency_in_progress` is an expected response with a `Retry-After` header. It is not an
error-budget event and should not be alarmed as one. A merchant whose client retries aggressively
will generate a steady low rate of them forever.

`409 idempotency_key_reuse` **is** a merchant bug: they reused a key for a different request. The
body hash is what catches it, and catching it is much better than replaying the wrong response.
The error's `details` name the endpoint and the original request time so support can tell them
what they collided with.

---

## 2. Which backend is a given route on

`IDEMPOTENCY_BACKEND` selects the default store for the whole service. `POST /v1/payment_intents`
pins Redis through `@Idempotent({ backend: 'redis' })` regardless of that setting, because it is
the highest-volume mutating route and its record does not need to be transactional with anything.

Everything else follows `IDEMPOTENCY_BACKEND`, and the default is Postgres — the record is written
in the same transaction as the business write.

### The known discrepancy

The two stores compute `Retry-After` differently. Postgres derives it from `lease_expires_at - now()`.
Redis derives it from the remaining PTTL, which is the lease plus whatever is left of the `SET`'s
own expiry. They differ by up to a second.

One spec asserts each separately, which is how we know about it. It is a real inconsistency,
nobody has filed it, and it has never mattered because clients round. If you are debugging a
client that retries exactly on the boundary, this is why the two routes behave slightly
differently.

---

## 3. Stuck leases

Symptom: a merchant gets `409 idempotency_in_progress` for a key whose request finished, or
crashed, minutes ago.

A lease is claimed on `begin()` and released on `complete()` or `fail()`. A task killed between
those leaves the lease held until `lease_expires_at` passes. `IDEMPOTENCY_LEASE_SECONDS` is that
window and it is deliberately short.

- **Postgres:** the reclaim is part of `begin()` — the `ON CONFLICT DO UPDATE … WHERE
  lease_expires_at < now()` clause. The next attempt after expiry claims it. No operator action.
- **Redis:** the reclaim is the Lua compare-and-set. Same behaviour, same non-action.

If leases are stuck for **longer than the configured lease**, the clock is wrong or the store is
not the one you think it is. Check both before touching data.

**Do not delete idempotency records to "unstick" a merchant.** Deleting a `completed` record turns
the merchant's next retry into a fresh request, and a fresh request on a payment route creates a
second charge. This is the single most dangerous manual action available on this service.

---

## 4. Retention

`IdempotencyRetentionJob` runs hourly and deletes records older than `IDEMPOTENCY_TTL_HOURS`.
That is separate from lease reclaim on purpose: a stuck lease should clear in seconds, a completed
record should stay available for a merchant's late retry for a day.

If the table is growing, the job is not running. See the jobs table in `payzeno-api.md`.

---

## 5. What is in the key

The stored hash covers `(merchant_id, livemode, idempotency_key, method, path,
canonical_json(body))`.

- **`livemode` is in there** since migration 23. Before that, a test-mode request could replay a
  live-mode response for the same key — and merchants pick keys like `order-1041` in both modes.
- **method and path are in there.** Without them an HTTP client that attaches one key to a whole
  request chain gets undefined behaviour across two endpoints, and the endpoint that wins is
  whichever landed first.
- **the body is in there**, which is what makes `idempotency_key_reuse` detectable at all.

Canonical JSON means key order and whitespace do not matter. A merchant re-serialising the same
object gets the same hash.

---

## 6. Replaying events is a different thing

If somebody says "replay", find out which they mean:

- **Idempotency replay** — a merchant retrying an HTTP request. This document.
- **Bus event replay** — an SQS message redelivered. `BaseEventConsumer.claimEvent` dedupes on
  `(event_id, consumer)` and the handler simply never runs a second time. See ADR 0011.
- **Webhook redelivery** — `POST /v1/webhook_events/:id/redeliver`. See `webhook-delivery.md`.

They have nothing to do with each other and conflating them wastes twenty minutes every time.
