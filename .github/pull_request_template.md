<!--
Title: <type>(<scope>): <subject>  PAYZ-<num>
e.g. feat(payments): retry settlement items from the console  PAYZ-1841
-->

## What

<!-- One paragraph. What changes for a merchant or for the console. -->

## Why

<!-- The ticket link is not a reason. Say the reason. -->

PAYZ-

## Checklist

- [ ] Layer rule holds — nothing imports upward (`pnpm lint` is green)
- [ ] New DTO `implements` its `@payzeno/contracts` type
- [ ] New error is an `ApiException` subclass with a branch in `HttpExceptionFilter`
- [ ] New env var: `.env.example` + `ApiConfig` + `config.schema.ts`, all three
- [ ] New migration is additive-then-backfill and safe against the running image
- [ ] Tests: unit for the unit, e2e if the request shape changed
- [ ] Nothing new logs a PAN, a CVV, or a full bank account number

## Blast radius

<!-- Which repos consume what you changed? payzeno-console? payzeno-ledger?
     A contracts bump goes in its own PR, merged first. -->
