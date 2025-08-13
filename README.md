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
