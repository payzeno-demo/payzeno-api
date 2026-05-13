# Runbook — payzeno-api

Owner: Platform. On-call co-owner for `src/jobs/**` and `src/health/**`: apager.

This is the page you open at 02:00. Sections are ordered by how often they get opened, not by
how the service is structured.

---

## 1. What this service is

Public REST API. Auth, merchants, payment intents, charges, refunds, disputes, webhooks. It is
stateless behind an ALB; all state is Postgres (`payzeno_api`), Redis (sessions, rate limits,
one idempotency backend, job locks) and SQS/SNS.

It is **not** the ledger. Money movement is posted by payzeno-ledger from events we emit. If a
balance looks wrong, the answer is almost never in this service.

## 2. Scheduled jobs

All nine extend `ScheduledJob`, all nine hold a Redis lease through `@JobLock(name, ttlSeconds)`,
all nine emit `job.started` / `job.finished` with the same field set (`src/jobs/job.types.ts`).
The CloudWatch metric filters in payzeno-infrastructure are one expression because of that. If
you add a field to `JobResult`, add it here at the same time.

| Job | Schedule | Lease | If it stops |
|---|---|---|---|
| `outbox-drain` | every 5s | 30s | **Page.** Events stop reaching the ledger. See §5. |
| `webhook-delivery` | every 15s | 60s | Merchant webhooks stall. See `webhook-delivery.md`. |
| `charge-expiry` | hourly | 900s | Authorisations expire at the acquirer without our `auth_release` posting. |
| `idempotency-retention` | hourly | 900s | Table grows. Not urgent. |
| `dispute-deadline-reminder` | daily 07:00 | 600s | Merchants miss evidence deadlines. Same-day fix. |
| `processed-event-retention` | daily 03:00 | 1800s | Table grows. Not urgent. |
| `risk-evaluation` | daily 04:00 | 1800s | Merchant risk tiers go stale. Same-day fix. |
| `unsettled-charge-sweep` | every 6h | 1800s | See §4. |

**A job that is not running looks exactly like a job that is running and finding nothing.**
That is what `job.finished` is for: it is emitted on every run, with `processed: 0` when there
was nothing to do. Alarm on the *absence* of `job.finished`, not on error rate.

### The lease is not a mutex

`@JobLock` is `SET NX PX` in Redis. If a job overruns its lease, a second instance can start
while the first is still running. Every job is written to tolerate that — batch claims are
`SELECT … FOR UPDATE SKIP LOCKED` or conditional updates — but if you see two overlapping
`job.started` for the same name, raise the lease rather than assuming corruption.

---

### What you do

1. **Scope it.** Query `support_task` for `type = 'duplicate_settlement'` opened in the window.
   That is the authoritative list of affected charges; do not reconstruct it from logs.
2. **Confirm on the ledger side** that the duplicate postings are real and not a
   `settlement.duplicate_detected` false positive from a redelivered chunk.
3. **Refund, do not reverse.** Remediation refunds go through `ChargesService` like any other
   refund, so they carry a `refund` row, a `refund.created` event and an audit trail. PAY-2042
   ran 218 of them this way. There is no "undo capture" path and there should not be one.
4. **Do not disable `capture_at_settlement`** to stop the bleeding. It changes which code path
   the merchant's *future* charges take, mid-incident, and `MerchantsService.update` logs that
   change on a line of its own precisely because it is the field that puts a merchant on the
   deferred-capture path.

### `409 settlement_locked` is not an error

Since PAY-2043, a settlement item retry that races a running sweep returns `409
settlement_locked` from the ledger and `SettlementsController` maps it straight out. The console
renders "already settling". Its **rate** is a useful signal — it means retries and sweeps are
overlapping — but it is not an error-budget burn and should not be alarmed as one.

---

## 4. Unsettled charge sweep

`settlement.completed` is the sole driver of `charge captured → settled`. It is chunked at 1000
ids and the bus is at-least-once and explicitly unordered. A chunk lost to the DLQ therefore
strands its charges `captured` with a null `settlement_batch_id` **forever**: the consumer never
sees the ids, `settlement_completion` never reaches its chunk count, and nothing else looks.

`pix_charge_unsettled` — the partial index those charges live under — existed for six months with
no reader at all. `UnsettledChargeSweepJob` (PAY-2058) is that reader.

Every six hours it takes charges captured longer ago than the settlement SLA and asks the ledger
directly: `GET /internal/v1/transactions?reference_type=charge`. If the ledger has posted a settle
transaction, the sweep marks the charge settled here. **If the ledger has no record, the sweep
reports and does not guess** — a charge the ledger never settled is either money we have not been
paid or a reconciliation orphan, and both need a human.

**If the sweep's `reported` count is non-zero, that is your work item.** It is a list of charges
where our view and the ledger's view disagree. Take it to the ledger on-call with the charge ids.

---

## 7. Config drift

Every environment variable has to exist in **three** places:

1. `.env.example`
2. `src/config/config.schema.ts` (class-validator over all 41)
3. `src/config/api-config.type.ts` (the `ApiConfig` shape)

Adding a var without all three is a review rejection. `process.env` is read in exactly one file,
`src/config/configuration.ts`, and `.eslintrc.cjs` bans it everywhere else with an override for
that file.

Two failure modes that look like application bugs:

- **A numeric var that arrives as a string.** The schema coerces and validates. A number stored
  as a string is how `port + 1` became `"30001"` in the sidecar wiring. If you see string
  concatenation where you expected arithmetic, the var is not going through the schema.
- **A var that validates but is never read.** The schema is the gate, `ApiConfig` is the shape,
  and a var present in the first but absent from the second is silently dropped. `configuration.spec.ts`
  asserts the mapping.

Boot fails loudly on invalid config — `ConfigValidationError` lists every failing var at once,
not the first one. That is intentional: fixing config one restart at a time is how a ten-minute
deploy becomes an hour.

---

## 9. Database

`synchronize` is false and stays false. The schema is owned by `src/migrations/` and the
bookkeeping table is `payzeno_migrations` — the same name in `src/config/database.config.ts` and
`src/migrations/data-source.ts`. If those two ever disagree, the app boots believing the schema
is empty.

`idle_in_transaction_session_timeout` is 30s. Postgres kills a wedged transaction rather than
letting it hold locks through a settlement window. A query that dies at exactly 30s inside a
transaction is this setting, working.

Reads and writes both go to the primary. There is no replica routing and
`assertNoReplicaRouting()` will throw if somebody adds it: the idempotency interceptor commits a
`completed` row and the serializer then re-reads the entity, so read-your-writes is required
across the whole request.
