/**
 * IdempotencyStore — three operations, two implementations, one contract suite
 * (`idempotency.store.contract.spec.ts` runs the same table against both).
 *
 * `begin` is the interesting one. It must be atomic: claim-or-report, never
 * check-then-insert. Both stores implement it as a single conditional write —
 * `INSERT … ON CONFLICT DO UPDATE … WHERE` in Postgres, `SET NX` plus a Lua compare in
