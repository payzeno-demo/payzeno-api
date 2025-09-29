# ADR 0006 — Acquirer routing, and why there is no failover

- **Status:** accepted
- **Date:** month 3
- **Author:** dhotfix
- **Implements:** `src/payments/processor/processor.router.ts`, `processor.adapter.ts`

## Context

We hold two acquirer relationships. Worldflow is the default and the only one with USD/JPY
interchange pricing. Nordpay is the EEA acquirer and holds the SEPA and UK scheme memberships.
A third, the sandbox, is not an acquirer at all — it is a deterministic fake so that a merchant
integrating against `sk_test_` keys never needs a sandbox account of their own.

Something has to decide which adapter an authorisation goes to, and the obvious next question
is what happens when that adapter is down.

## Decision

### Routing is by currency and merchant, and nothing else

`ProcessorRouter.select(merchant, currency, { livemode })` reads
`ProcessorAdapter.supportedCurrencies` and the merchant's pinned acquirer, in that order:

1. `livemode === false` → `SandboxProcessorAdapter`. Always. A test-mode charge never leaves
   the process.
2. The merchant has an explicit acquirer pin → that adapter, if it supports the currency.
   A pin that does not support the currency is a configuration error and throws, loudly, at
   authorisation time rather than silently rerouting.
3. Otherwise the first adapter whose `supportedCurrencies` contains the currency. Worldflow is
   registered first, so it is the default for the currencies both support.

The currency table lives on the adapter, not in the router, so that adding an acquirer is one
file.

### There is deliberately no health-based failover

This is the part people argue with, so it gets its own heading.

Re-routing an authorisation to a second acquirer mid-outage produces two authorisations on the
same card as often as it rescues one. The failure modes that look like "the acquirer is down"
from our side — read timeout, connection reset, 502 from their edge — are exactly the failure
modes where the authorisation may well have succeeded on their side. We cannot tell. The
scheme's duplicate-authorisation rules are not on our side, and a duplicate auth on a debit
card holds the cardholder's money twice for up to a week.

So: the circuit breaker fails the call, we return `502 processor_unavailable`, and the merchant
retries. A merchant retry is idempotent (ADR 0004) and arrives with the merchant's own intent
attached. That is a strictly better place for the decision than our routing table.

The one thing we do automate is the breaker itself: one opossum circuit per acquirer, 50% error
rate over a 20-request rolling window, 30s reset. It fails fast, it recovers on its own, and it
never changes where a request goes.

## Consequences

- `ProcessorRouter` is fifty lines and has no dependency on health state. It is L4 and pure
  enough to test without a module.
- During the Worldflow degradation in month 9, every affected authorisation returned
  `502 processor_unavailable` in under 30ms once the circuit opened. None of them were
  double-authorised. The damage that night came from the settlement path, not this one — see
  `docs/runbooks/payzeno-api.md`, "duplicate settlement remediation".
- Adding a third acquirer means: one adapter file, one currency list, one entry in the router's
  registration order. No routing logic changes.
