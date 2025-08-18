/**
 * MerchantsModule — the tenant aggregate: Merchant, MerchantUser, ApiKey, BankAccount.
 *
 * Imports (blueprint §2): CommonModule, LedgerModule (bootstrapAccounts on onboarding),
 * EventsModule (the four `merchant.*` emits), AuditModule.
 *
 * It exports more than a feature module usually would, and each export has exactly one
 * consumer that cannot be satisfied any other way:
 *
 *   MerchantsService        PayoutsService (status check), LedgerEventsConsumer
 *                           (`capture_at_settlement` on the duplicate branch), the payment flows
 *   MerchantRepository      MerchantScopeGuard — the tenant boundary is a guard and guards may
 *                           not import services
 *   MerchantUserRepository  AuthService's login lookup
 *   ApiKeyRepository        ApiKeyResolver's O(1) split-token lookup
 *   ApiKeyHasher            provided HERE rather than in AuthModule on purpose: AuthModule
 *                           imports this module, so providing it there and consuming it here
 *                           would be a module cycle. The table lives here, so the hasher does.
 *   BankAccountsService     InternalController#getBankAccount, the ledger's stale-projection
 *                           fallback
