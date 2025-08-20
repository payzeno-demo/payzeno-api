/**
 * AuthModule — credentials in, `AuthPrincipal` out.
 *
 * Imports (blueprint §2): CommonModule, MerchantsModule (the ApiKey and MerchantUser tables
 * live there), StaffModule, AuditModule.
 *
 * `SESSION_STORE` is the one binding worth reading. `RedisSessionStore` is production;
 * `InMemorySessionStore` is bound when `NODE_ENV=test`, so the e2e suite can log in without a
 * Redis container. Both implement `SessionStore` and both are wired in production code —
 * a test double bound by a spec would not count as a second implementation.
 *
 * Every guard is exported, and this module is the ONE `@Global()` in the repo.
 *
 * That is a deliberate exception to the rule CommonModule states (explicit imports, so the
 * `IMPORTS` edges are real). Nine modules list these guards in `@UseGuards(...)`, including
 * `MerchantsModule` — which this module imports, because the `api_key` and `merchant_user`
 * tables live there. Making those nine import `AuthModule` back would put a cycle through
 * the tenant aggregate, and `forwardRef` in nine places is worse than one honest `@Global`.
