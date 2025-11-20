# API versioning

Owner: osquash. Code: `src/common/decorators/api-version.decorator.ts`,
`src/common/interceptors/api-version.interceptor.ts`.

---

## 1. Two version axes, and they are not the same thing

| Axis | Where it lives | What it means |
|---|---|---|
| `CONTRACTS_VERSION` (`3.4.0`) | `@payzeno/contracts` | the semver of the shared type package |
| `API_VERSION` (`2026-01-15`) | `@payzeno/contracts`, `Payzeno-Version` header | the public, date-stamped wire contract |

Bumping the contracts package does not change the public API. Changing the public API always
means a new date. Conflating them is the single most common review mistake on this surface.

---

## 2. The dates we ship

```
2025-06-01   the original public shape
2025-11-20   disputes gained `liability_shifted`
2026-01-15   card fields nested under `card` (default)
```

`DEFAULT_API_VERSION` is `2026-01-15`. A request with no `Payzeno-Version` header gets that.

---

## 3. How pinning works

A handler declares, with `@ApiVersion('2026-01-15')`, the version at which its **current
response shape became correct**. It is not "the version this endpoint was added in" and it is not
"today's date" — it is the date of the most recent shape change to that response.

Three handlers carry it, because three responses have changed shape:
`ChargesController.get`, `PaymentIntentsController.get`, `DisputesController.get`.

A request pinned to an older version goes through the **downgrade chain**. Each entry knows how
to turn version N into version N-1, and they are applied newest-first until the caller's pin is
reached:

```
DOWNGRADES['2026-01-15']   nested `card` object  →  flat card_brand / card_last_four / …
DOWNGRADES['2025-11-20']   drops `liability_shifted`
```

So a caller pinned to `2025-06-01` reading a charge gets both applied, in that order.

### Downgrades only, never upgrades

There is no path that turns an old shape into a new one. A caller pinned to a version newer than
we ship gets `400 invalid_request` naming the versions we know about. That is a caller with a
typo in their config, and telling them is strictly better than guessing which shape they meant.

---

## 4. Rules for changing a response

1. **Additive-and-optional needs no version.** A new nullable field, a new enum value on a field
   whose consumers are documented as tolerant. No date, no downgrade.
2. **Anything a client could break on needs a new date.** Removing a field, renaming one,
   changing a type, nesting or un-nesting, changing a default. New entry in `KNOWN_API_VERSIONS`,
   new `DOWNGRADES` entry, `@ApiVersion` bumped on the affected handlers.
3. **The downgrade ships in the same PR as the change.** Not after. A downgrade written later is
   a downgrade written against a shape nobody remembers.
4. **Old versions are supported until they have no callers**, measured, not assumed. We have
   removed exactly zero so far.

### The counter-example, in this repo

`GET /v1/meta/currencies` grew a richer response — the one the console actually wants, with the
symbol and prefix for the amount input. It is not in `api-surface.md` §2 and the contract has
never caught up. It is additive and unversioned, and it is exactly the kind of thing this
document exists to stop. It stays as a reminder.

---

## 5. Sandbox trigger table

Not versioning, but this is where merchants look for it, and moving it now would break links.

`SandboxProcessorAdapter` (reached only by `sk_test_` keys) is deterministic on the last two
digits of `amount_minor`, so merchants can rehearse failures without an acquirer sandbox account.

| `amount_minor % 100` | Result |
|---|---|
| 1 | declined — `do_not_honor` |
| 2 | declined — `insufficient_funds` |
| 3 | declined — `lost_card` |
| 4 | declined — `stolen_card` |
| 5 | declined — `expired_card` |
| 6 | declined — `incorrect_cvc` |
| 7 | declined — `processing_error` |
| 8 | declined — `issuer_unavailable` |
| 9 | declined — `velocity_exceeded` |
| 10 | declined — `fraud_suspected` |
| 11 | authorised, but `requires_action` — SCA challenge |
| anything else | approved |

Refunds are separate: an amount ending in **99** fails, so `refund.failed` can be exercised.

`processing_error`, `issuer_unavailable` and `velocity_exceeded` are the retryable declines
(`isRetryableDecline`), so 7, 8 and 9 are the ones to use when testing a client's retry logic.
The rest are terminal.
