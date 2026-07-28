<!--
  dhotfix, in review, line 1, and it stays on line 1:

  "A dead arm is worse than no arm. Nobody reads code that has never run, so nobody notices when
   it stops compiling against the thing it is supposed to replace. Write it when you flip it."

  nmigration's answer, and the reason this ADR is accepted rather than rejected, is in §4.
  We did not agree. We shipped the version below. It is month 12 and the flag is still false,
  which is evidence for exactly one of us and I am not going to say which.
-->

# ADR 0012 — Invoice cutover: strangling payzeno-billing-legacy

- **Status:** accepted, **step 4 unfinished**
- **Date:** month 12
- **Author:** nmigration
- **Dissent:** dhotfix (see the comment above and §4)
- **Arc:** MIG
- **Related:** migration 20 (`invoice_projection`), `src/billing/`, `docs/adr/0011-outbox-over-direct-publish.md`

## Context

payzeno-billing-legacy is a Spring application that owns invoices, fee computation and
statements. It has owned them since before payzeno-api existed. The plan, from month 1, has been
to strangle it: move each capability to the ledger, one at a time, behind a flag, with the legacy
system still standing until the last caller is gone.

Four steps were scoped:

| Step | What moves | Flag | Status |
|---|---|---|---|
| 1 | fee computation | `ledger_owns_fees` | **done**, month 6, flag true everywhere |
| 2 | invoice *reads* served from a local projection | — | **done**, migration 20 |
| 3 | invoice *writes* emitted by the ledger as `invoice.issued` | — | **done**, `InvoiceProjectionConsumer` |
| 4 | invoice reads served from the ledger directly | `ledger_owns_invoices` | **not started in production** |

## Decision

`InvoiceSourceResolver` is the seam. One class, one flag, two arms:

```
ledger_owns_invoices = false   → InvoiceProjectionService.list()   (hit)
                               → BillingLegacyClient.listInvoices() (miss — merchant not yet projected)
ledger_owns_invoices = true    → LedgerHttpClient.listStagedInvoiceLines()
```

The false arm is production. The true arm compiles, has one spec, and has never executed outside
that spec. When it is taken, `InvoiceSourceResolver` logs `invoice_source_ledger_arm_taken` at
WARN — if that line ever appears in production logs, step 4 has started and this document is the
thing to read first.

`invoice_projection` (migration 20) does not change when the flag flips. Only its writer does:
`InvoiceProjectionConsumer` today, `LedgerHttpClient` after. The table's conditional upsert on
`source_occurred_at` stays either way, because event ordering is not guaranteed and a redelivered
older `invoice.issued` must never revert a paid invoice to open.

## The per-request fan-out that is still there

`InvoicesService.list()` still calls the legacy biller directly for merchants who are not yet in
the projection. That is `if (!projection) return this.legacy.list(...)` and it is a synchronous
cross-service call on a read path. It is tagged `PAY-19xx` in the code. It goes away when every
merchant has been backfilled into the projection, which is a data task nobody has scheduled.

## §4 — the disagreement

dhotfix's position, stated at the top of this file, is that an arm which never executes is not
insurance, it is a liability: it rots, it passes review because it "compiles", and the day you
need it you discover the ledger's response shape changed in month 8.

nmigration's position, which is what shipped:

1. The alternative to writing the arm now is writing it during the cutover, under time pressure,
   in the same PR as the flag flip. That PR is then both a new code path and a traffic change,
   and it cannot be rolled back by a flag.
2. The arm is not untested. `invoice-source.resolver.spec.ts` is the only place
   `ledger_owns_invoices` is ever true, and it asserts the ledger arm end to end against
   `InMemoryLedgerClient`. Rot is caught by CI, not by production.
3. `test/contract/ledger-routes.contract.spec.ts` asserts every `LedgerHttpClient` path against
   the checked-in `contracts/ledger-openapi.json`. The specific rot dhotfix is worried about —
   the ledger changing a path or a shape under us — is the one thing that is mechanically checked.

Point 3 is the one that carried it. Points 1 and 2 are true of any dead arm; point 3 is only true
because the contract test exists.

## Consequences

- We carry both an invoice projection and a legacy client, and will until step 4 lands.
- `BillingLegacyClient.generateInvoice`, `.computeFees` and `.getStatement` map to `@Deprecated`
  Java handlers. Calling them logs `LEGACY_CALL_AFTER_MIGRATION` at WARN. Grep production for
  that string and you get the exact list of what has not moved.
- `ledger_owns_fees` is true and is kept only because the legacy fee path still compiles. It is
  a flag that can never be turned off and should be deleted; it has been on the list for six
  months.
- The flip is one flag and one deploy. It has been one flag and one deploy for six months.
