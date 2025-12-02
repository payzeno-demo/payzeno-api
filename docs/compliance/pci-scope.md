# PCI DSS scope — payzeno-api

Owner: dhotfix. Reviewed with the QSA at the month-8 interim. Arc: PCI.

This is the document an assessor reads. It states what payzeno-api stores, what it transmits,
what it can see, and the one path that keeps a residual obligation open.

---

## 1. Claim

payzeno-api qualifies under **SAQ A-EP**, not SAQ D.

The argument in one paragraph: payzeno-api does not receive, transmit or store cardholder data on
the payment path. The merchant's checkout page — which payzeno-api serves the configuration for
but not the card fields — posts card details directly to payzeno-vault from the cardholder's
browser. payzeno-api receives a `pmt_` token. It exchanges that token for a set of non-sensitive
card attributes at authorisation time and never for the PAN.

That places payzeno-api in the "merchant website does not receive cardholder data but does affect
the security of the payment transaction" category, which is SAQ A-EP.

---

## 2. What payzeno-api stores

Per charge, from `VaultClient.resolve()`:

| Field | PCI classification | Why we keep it |
|---|---|---|
| `card_brand` | not CHD | routing, interchange, display |
| `card_last_four` | permitted under A-EP | merchant and cardholder reconciliation |
| `card_exp_month` / `card_exp_year` | permitted | authorisation expiry logic, decline reasons |
| `card_funding` | not CHD | pricing, `LivemodeOnly` payout rules |
| `card_country` | not CHD | routing and risk |
| `card_fingerprint` | not CHD — opaque, vault-issued | velocity, duplicate detection |

**Not stored, anywhere, in any form:** PAN, CVV/CVC, magnetic stripe or chip data, PIN or PIN
block.

### It was not always true

Migration 02 (month 1) created `charge.pan_first_six` and `charge.pan_encrypted`. The encryption
was real and the key was in KMS, and it was still the wrong design: it made payzeno-api a system
that stores cardholder data, and everything connected to it — the database, its backups, the log
pipeline, the bastion, the people with access to any of those — came into scope with it.

**Migration 10 (`DropCardPanColumns`, month 5) drops both columns** and backfills `card_last_four`.
It is irreversible in practice: the `down()` recreates the columns empty, because the data is
gone. That is the intended outcome, not an oversight.

---

## 3. What payzeno-api transmits

| Path | Contains CHD? | Notes |
|---|---|---|
| browser → payzeno-vault | yes | does not traverse payzeno-api. TLS 1.2+. |
| payzeno-api → payzeno-vault (`POST /tokens/resolve`) | no | sends a token, receives attributes |
| payzeno-api → acquirer (`AcquirerHttpClient`) | no | sends the acquirer's own network token / vault reference |
| payzeno-api → payzeno-ledger | no | amounts and identifiers only |
| payzeno-api → merchant webhook endpoints | no | `card` object is brand + last four |

---

## 4. The residual path: server-side MOTO tokenisation

`VaultClient.tokenise()` accepts a PAN and hands it to the vault. It is the one place in
payzeno-api where a PAN can exist in process memory.

Controls on it:

- Reachable through exactly one route, gated `@StaffOnly('support')`.
- Every call logs `SERVER_SIDE_TOKENISATION` at WARN, with the staff actor id, and writes a
  `staff_audit_log` row through `AuditLogInterceptor`.
- The PAN is never written to a database column, never placed in a log field, and never returned
  in a response body.
- `RedactionInterceptor` covers the request body and the log context for that route as it does
  for every other.

It exists because a small number of merchants take card numbers over the phone and key them into
the support console. That flow is genuinely in scope. Closing it requires those merchants to move
to a hosted MOTO page — a product decision, not an engineering one. It has been "next quarter"
for four months and it is the last thing standing between us and a clean A-EP.

**Assessor note:** this path is disclosed, not hidden. The compensating controls above are what we
present; we do not claim the path does not exist.

---

## 5. Defence in depth against accidental CHD

A PAN can arrive where it should not: in a `metadata` value, in a `description`, in a merchant's
own logged request body attached to a support ticket. Four layers:

1. **`metadata.validator.ts`** — rejects PAN-shaped metadata values at the DTO with a 422, so the
   merchant is told rather than having it silently starred.
2. **`redaction.denylist.ts`** — sixteen field names, matched case-insensitively
   (`card_number`, `cvv`, `account_number`, and the rest).
3. **`pan.matcher.ts`** — Luhn check over 13–19 digit runs, tolerant of spaces and dashes,
   because a human pasting a card number does not paste it clean.
4. **`RedactionInterceptor`** — applied to request bodies, response bodies, log context **and**
   `ValidationError.field_errors[].path`.

That fourth application point is not paranoia. The validation error for an unrecognised field
echoes the field's value, and an unrecognised field is precisely where a stray PAN turns up.

`redact_pan_in_logs` is a named feature flag that is on and cannot be turned off. It is named so
this document and the runbook have something to point at, not so anyone can flip it. The A-EP
argument depends on the redaction being unconditional.

---

## 6. Evidence for an assessment

| Control | Evidence |
|---|---|
| No PAN column exists | `src/migrations/1721400000000-DropCardPanColumns.ts`; current schema |
| No PAN in DTOs | `src/payments/dto/create-payment-intent.dto.ts` — no `card_number`, `cvv`, `exp_month` |
| Tokenisation is client-side | `docs/adr/0014-client-side-tokenisation.md`; `VAULT_PUBLIC_URL` is served, never called |
| Redaction is unconditional | `src/common/redaction/redaction.interceptor.spec.ts` |
| PAN detection works | `src/common/redaction/pan.matcher.spec.ts` (Luhn, spacing, false-positive cases) |
| MOTO path is audited | `staff_audit_log` rows; `SERVER_SIDE_TOKENISATION` WARN lines |
