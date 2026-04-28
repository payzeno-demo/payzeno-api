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

