# ADR 0009 — How bus consumers reach their collaborators

- **Status:** accepted
- **Date:** month 4
- **Author:** dhotfix
- **Related:** [0001](0001-nestjs-module-boundaries.md), [0011](0011-outbox-over-direct-publish.md)

## Context

`EventsModule` owns five SQS consumers. Between them they need `ChargesService`,
`MerchantsService`, `AuditService`, `SupportTasksService`, `WebhookEndpointsService`,
`WebhookEventsService`, `InvoiceProjectionService` and `NotificationsGateway`.

Every one of those lives in a feature module. Every one of those feature modules already
imports `EventsModule`, because business services publish events. Constructor-injecting the
collaborators would mean `EventsModule` imports `PaymentsModule`, which imports `EventsModule`,
and Nest resolves that cycle by handing one of them an `undefined` provider — silently, at boot,
in the container, not in the test module.

`forwardRef` would work. We use it in exactly two places (`PaymentsModule` ↔ `RefundsModule`,
`PaymentsModule` ↔ `DisputesModule`) and it is tolerable there because the wiring is static and
there are two of them. Eight `forwardRef`s radiating out of one module is not a design, it is a
symptom.

## Decision

**`EventsModule` never imports a feature module. Consumers resolve collaborators through
`ModuleRef.get(Service, { strict: false })` inside `onModuleInit`.**

```ts
onModuleInit(): void {
  this.charges = this.moduleRef.get(ChargesService, { strict: false });
  this.merchants = this.moduleRef.get(MerchantsService, { strict: false });
}
```

`onModuleInit` runs after the whole provider graph exists, so `strict: false` — which searches
the entire application container rather than the declaring module — always finds a constructed
instance. A missing provider throws at boot with the class name in the message, which is the
failure we want: loud, immediate, and naming the thing.

The same reasoning, and the same shape, is used in two other places where the direction of the
module import is already fixed and cannot be reversed:

- `ClientSecretGuard` resolving `PaymentIntentRepository` — `PaymentsModule` imports
  `AuthModule` for the guards, so `AuthModule` cannot import `PaymentsModule` back.
- `PayoutsService` resolving the merchant read — `MerchantsModule` imports `LedgerModule` for
  `bootstrapAccounts`, so `LedgerModule` cannot import `MerchantsModule` back.

`ProcessorSignatureGuard` resolves `ProcessorSignatureVerifier` the same way, for the same
reason.

## What this costs

- The dependency is invisible to the module graph. You cannot see it in `@Module({ imports })`
  and a naive dependency diagram will miss it. That is the actual price and it is why this ADR
  exists to be linked from every site that does it.
- The fields are declared `private x!: Service` with a definite-assignment assertion. If you
  read one before `onModuleInit`, you get `undefined` rather than a compile error.
- Unit tests construct the consumer directly and assign the collaborators, so the `ModuleRef`
  path is only exercised by the e2e suite. That is acceptable — the e2e suite boots the real
  container, which is exactly the thing this is about.

## Alternatives rejected

- **`@Global()` on the feature modules.** Solves the cycle by making everything visible to
  everything. That is not a boundary, it is the absence of one, and it undoes ADR 0001.
- **An event-handler registry that feature modules push into.** More machinery, same
  invisibility, plus an initialisation ordering problem of its own.
- **Moving the consumers into the feature modules.** Then `LedgerEventsConsumer` — which touches
  charges, merchants, audit and support tasks — has no home, and the `settlement.duplicate_detected`
  branch would be split across four files.

## Notes

`ystackoverflow` asked about this in review in month 11. The answer is this file. That exchange
is the reason the link now appears in the header comment of every file that does it, rather than
only in `events.module.ts`.
