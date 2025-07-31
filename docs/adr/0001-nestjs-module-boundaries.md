# ADR 0001 — Module boundaries and the eight-layer import rule

- **Status:** accepted
- **Date:** month 1
- **Author:** dhotfix
- **Supersedes:** nothing. This is the first one.
- **Enforced by:** `eslint-plugin-boundaries` in `.eslintrc.cjs`, and review

## Context

Nest gives you modules and stops there. Nothing in the framework prevents a controller from
injecting a `Repository<Charge>` and calling `find()`, and nothing prevents an HTTP client
from importing a service to "just look the merchant up". Both happened in the first three
weeks. The second one produced an import cycle that only failed at runtime, in a container,
on a Friday.

We are a payments API. The thing that makes a payments codebase survivable is that you can
answer "what can reach the acquirer from here" by reading the imports, not by running it.

## Decision

Eight layers, numbered, with a strict downward-only import rule. A module may import from its
own layer and any layer below it. Never above.

| Layer | What lives there | Path |
|---|---|---|
| L8 | controllers | `src/**/*.controller.ts` |
| L7 | application services | `src/**/*.service.ts` extending `BaseService` |
| L6 | flows / orchestrators | `src/payments/flows/`, `*-onboarding.service.ts` |
| L5 | domain policies and state machines | `src/**/state/`, `*.policy.ts` |
| L4 | gateway services | `ProcessorRouter`, `LedgerReadThroughService`, `InvoiceSourceResolver` |
| L3 | protocol adapters | `ProcessorAdapter` impls, `LedgerHttpClient`, `BillingLegacyClient`, `VaultClient`, delivery strategies |
| L2 | transport | `src/api/client.ts`, `RetryPolicy`, `CircuitBreakerRegistry` |
| L1 | persistence | `PayzenoRepository<T>` → TypeORM `Repository<T>` → `DataSource` |
| L0 | primitives | ids, money, clock, logger, flags, errors, decorators |

Three consequences that are not obvious from the table:

1. **A controller may not touch a repository.** If a handler needs one row, it goes through
   its service. This looks like ceremony on `GET /v1/charges/:id` and it is what stops the
   fourteenth handler from writing its own `merchant_id` filter and forgetting `livemode`.

2. **L5 is pure.** State machines and policies take values and return values. No injection, no
   I/O, no clock except the injected `Clock`. That is why `ChargeExpiryPolicy` and
   `RefundPolicyService` have unit tests with no test module at all.

3. **`src/api/` is L2 and is the only place a socket is opened.** Every cross-repo HTTP call in
   this service passes through `BaseHttpClient.request()`. There is exactly one place that owns
   timeouts, retries, breaker state and error mapping, and that is the point.

## Flows (L6) — why the extra layer

`PaymentIntentsService` would otherwise be nine hundred lines. A confirm touches the intent, a
charge, the vault, an acquirer, the ledger and the outbox; a capture touches four of those; a
cancel touches three. Each is a transaction with its own failure semantics, and mixing them
into one service produced a file nobody could review. `PaymentFlow` and its three concretes
are the transaction boundary; the service above them is thin on purpose.

## Cycles

The rule removes most cycles by construction. Two remain and are handled explicitly:

- `PaymentsModule` ↔ `RefundsModule`/`DisputesModule`: two documented `forwardRef`s. The
  alternatives were a fourth module owning nothing but a switch statement, or non-strict
  `ModuleRef` resolution — which is worse here, because the wiring is static.
- `EventsModule` ↔ every feature module: `EventsModule` never imports a feature module at all.
  Consumers resolve collaborators through `ModuleRef` in `onModuleInit`. That has its own ADR,
  [0009](0009-event-consumer-wiring.md), because the reasoning is different: there the wiring
  genuinely is dynamic.

## Consequences

- Call chains are deep. `PaymentIntentsController.capture()` is nine frames from the socket.
  That is a feature: every frame is a place to put a test, a log line or a breaker.
- New engineers hit the boundaries lint before they hit review. Good.
- `MetaController` is registered directly in `AppModule.controllers` with no home module. It
  is the one exception, it has been the one exception for eleven months, and it is called out
  in a comment rather than fixed.

## Notes

`osquash` rejects PRs that break the layer rule and says so in two words. The linter now
catches it first, which was the whole idea.
