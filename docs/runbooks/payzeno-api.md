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

