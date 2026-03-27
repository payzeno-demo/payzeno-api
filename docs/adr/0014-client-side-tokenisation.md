# ADR 0014 — Client-side tokenisation: card data never reaches payzeno-api

- **Status:** accepted
- **Date:** month 8
- **Author:** dhotfix
- **Arc:** PCI
- **Related:** migration 10 (`DropCardPanColumns`), `docs/compliance/pci-scope.md`,
  `src/payments/vault/vault.client.ts`

## Context

Month 1 shipped `charge.pan_first_six` and `charge.pan_encrypted`. The encryption was real, the
key was in KMS, and it was still the wrong design: it put payzeno-api inside PCI DSS scope as a
system that stores cardholder data. Everything that touches a system in that scope — the
database, its backups, the log pipeline, the bastion, the people with access to any of them —
comes into scope with it.

The cost of that is not the audit. It is that every future decision gets an extra constraint,
forever, including ones that have nothing to do with cards.

## Decision

**The browser tokenises directly against payzeno-vault. payzeno-api never sees a PAN.**

The flow:

1. The console (or the merchant's own checkout) loads `VAULT_PUBLIC_URL` — a value payzeno-api
   hands out and never calls itself.
2. The cardholder's browser POSTs the card details straight to the vault, over TLS, without
   traversing any payzeno-api process.
3. The vault returns a single-use `pmt_` token.
4. The token is what arrives at `POST /v1/payment_intents`. `CreatePaymentIntentDto` has no
   `card_number`, no `cvv`, no `exp_month`, and since migration 10 there is nowhere in the
   schema for those to go even if it did.
5. At authorisation, `VaultClient.resolve(token)` exchanges the token for a `CardSummary` —
   brand, last four, expiry month/year, funding, country, and a fingerprint. Those six fields
   are permitted under SAQ A-EP. The digits never enter this process.

`resolve()` is the only vault call payzeno-api makes on the normal path. `DELETE /tokens/{t}`
is the second, called when an intent is cancelled.

## The exception that survives

`VaultClient.tokenise()` — server-side tokenisation, where payzeno-api receives a PAN and hands
it to the vault — still exists. It is reachable through exactly one route, that route is
`@StaffOnly('support')`, and every call logs `SERVER_SIDE_TOKENISATION` at WARN.

It exists for MOTO: a small number of merchants take card numbers over the phone and key them
into the support console. That flow is genuinely in scope and is the reason
`docs/compliance/pci-scope.md` has a section rather than a sentence.

It is the last thing standing between us and a clean SAQ A-EP. Removing it requires those
merchants to move to a hosted MOTO page, which is a product decision, not an engineering one.
It has been "next quarter" for four months.

## Defence in depth, because the token boundary is not enough on its own

A PAN can still arrive by accident — in a `metadata` value, in a `description`, in a log line
from a merchant who logged their own request body and sent us the trace. Four layers catch that:

- `RedactionInterceptor` applies to request bodies, response bodies, log context **and**
  `ValidationError.field_errors[].path`. That last one is not paranoia: the validation error for
  an unknown field echoes the field's value, and an unknown field is exactly where a stray PAN
  turns up.
- `redaction.denylist.ts` — sixteen field names, matched case-insensitively.
- `pan.matcher.ts` — Luhn check over 13-19 digit runs with space and dash tolerance.
- `metadata.validator.ts` — rejects PAN-shaped metadata values at the DTO, with a 422, so the
  merchant finds out rather than having it silently starred.

`redact_pan_in_logs` is a named flag that is on and cannot be turned off. It is named so the
runbook has something to point at, not so anyone can flip it.

## Consequences

- Migration 10 drops both PAN columns and backfills `card_last_four` from `pan_first_six`'s
  sibling. It is irreversible in practice: the `down()` recreates the columns empty, because the
  data is gone and that is the point.
- The compliance argument is SAQ A-EP rather than SAQ D. That is documented in
  `docs/compliance/pci-scope.md` and is the thing an assessor reads.
- Merchants integrating server-side must use the vault's own SDK. That is a real integration
  cost we pushed onto them and it is the correct trade.
