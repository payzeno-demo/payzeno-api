# payzeno-api

The public REST API. Auth, merchants, payment intents, charges, refunds, disputes,
webhooks, and the read-through half of the money path. If a merchant or the console
touched it, it came through here.

Owned by **Platform**. Lead: @osquash. Escalation: @dhotfix.

Everything below is either something you need to run the service or something that has
cost us a production incident. There is no filler in this file — if a section looks
pedantic, read it twice.

---

## What this service is, precisely

payzeno-api is a **NestJS 10 / TypeORM 0.3 / Postgres 15** service that owns:

- **the public surface** — everything under `/v1`, consumed by payzeno-console and by
  merchant integrations directly (API keys)
- **auth** — sessions (console), API keys (server-to-server), client secrets (browser
  confirm), staff, and internal-service auth
- **the merchant aggregate** — merchants, users, API keys, bank accounts, risk state
- **the payment aggregate** — payment intents and charges, the state machines that
  govern them, and the acquirer adapters underneath
- **the internal surface** — six routes under `/internal/v1` that payzeno-ledger and
  payzeno-billing-legacy call back into. nginx denies `^/internal/` on the public
  listener; the `InternalServiceGuard` denies it again. Both, always.

payzeno-api does **not** own money. Balances, settlement, payouts and reconciliation
live in **payzeno-ledger** and we read through to it over HTTP. If you find yourself
computing a balance in this repo, stop and go read `docs/adr/0001`.

Invoices are a half-migrated mess and we are honest about it — see
[arc MIG](#the-billing-situation) below.

---

## Setup

payzeno-api resolves `"@payzeno/contracts": "workspace:*"`. It is a separate repo but the
**same pnpm workspace**, so it has to be checked out as a sibling. This trips up everyone
exactly once:

```bash
mkdir payzeno && cd payzeno
git clone git@github.com:payzeno/payzeno-contracts.git
git clone git@github.com:payzeno/payzeno-api.git
cp payzeno-api/.github/workspace/pnpm-workspace.yaml .
cp payzeno-api/.github/workspace/package.json .
cp payzeno-api/pnpm-lock.yaml .

corepack enable && corepack prepare pnpm@8.15.8 --activate
pnpm install
pnpm --filter @payzeno/contracts build
```

Then, from `payzeno-api/`:

```bash
cp .env.example .env
docker compose -f ../payzeno-infrastructure/docker-compose.yml up -d \
  payzeno-postgres-api payzeno-redis payzeno-localstack payzeno-vault
pnpm migration:run
pnpm start:dev            # http://localhost:8080
```

`GET /healthz` is liveness and touches nothing. `GET /readyz` pings Postgres, Redis and
the ledger — if it is red on a fresh machine it is almost always the ledger, not you.

To run the whole world instead (nginx, ledger, legacy biller, console):

```bash
docker compose -f ../payzeno-infrastructure/docker-compose.yml \
               -f docker-compose.override.yml up
```

The override file only rebinds this one service to your working tree. Do not add
services, ports or `depends_on` entries to it — Infrastructure owns the topology and the
PR will bounce.

**Node 20.11.x.** Not 22. `argon2` and the OTel SDK pins are the reason; `engines` is
enforced and pnpm will refuse to install on the wrong major.

---

## Layout, and the one rule

Eight layers, downward imports only:

```
L8  controllers            *.controller.ts
L7  application services   *.service.ts        (extends BaseService<TEntity>)
L6  flows / orchestrators  payments/flows/     multi-aggregate transactions
L5  domain policies + FSMs **/state/, *.policy.ts     pure, no I/O
L4  gateway services       ProcessorRouter, LedgerReadThroughService, InvoiceSourceResolver
L3  protocol adapters      ProcessorAdapter impls, LedgerHttpClient, VaultClient, …
L2  transport              src/api/  (BaseHttpClient + RetryPolicy + CircuitBreaker)
L1  persistence            PayzenoRepository<T> → TypeORM Repository<T>
L0  primitives             ids, money, clock, logger, flags, errors, decorators
```

A module may import from its own layer and any layer below it. Never above.

This is not a style preference, it is `eslint-plugin-boundaries` in `.eslintrc.cjs` and it
fails CI. When you see `boundaries/element-types` in a red build, you reached upward —
usually a controller calling a repository directly, or a policy that grew an HTTP call.
Move the call into the layer that owns it. The fix is never to add an exception to the
config.

Corollaries, all lint-enforced:

- **`process.env` is read in exactly one file**: `src/config/configuration.ts`. Everything
  else takes `ApiConfig` by injection. `config.schema.ts` validates all 41 vars at boot and
  the process exits non-zero on the first bad one.
- **`HttpException` is constructed in exactly one file**: `src/common/filters/http-exception.filter.ts`.
  Everywhere else you throw an `ApiException` subclass from `src/common/errors/`. There is
  a class per error code; that is deliberate, and no, do not collapse them into an enum.
- **Feature flags are read through `FeatureFlags`**, never `process.env.FLAG_*`.
- **Every DTO `implements` its `@payzeno/contracts` type.** A DTO that restates a contract
  shape by hand will be rejected — the whole point of the contracts package is that the
  console and the ledger break at compile time when we change a payload.

---

## Testing

```bash
pnpm test          # colocated *.spec.ts, ~2.5k assertions
pnpm test:cov      # the 80% line gate CI enforces
pnpm test:e2e      # supertest against a booted app; needs Postgres + Redis
```

The e2e suite boots a real Nest app with `InMemoryLedgerClient` and `InMemoryTransport`
swapped in, so it never opens a socket to anything real. If an e2e test tries to,
`http://ledger.invalid` fails loudly and that is the intended behaviour.

`test/contract/ledger-routes.contract.spec.ts` asserts every path `LedgerHttpClient` calls
exists in the checked-in `contracts/ledger-openapi.json`. When Core renames a ledger route,
that spec is what tells us before production does. Refresh the spec file when you bump it;
do not delete the assertion.

The 80% gate is real and two directories are permanently dragging us toward it —
`src/reporting/**` and `src/merchants/users/**`. If you are in either, you are expected to
leave it better than you found it.

---
