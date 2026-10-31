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
 * dhotfix argued for forwardRef in review and lost; docs/adr/0001-nestjs-module-boundaries.md
 * §6 records the decision.
 *
 * Exporting the guards is not enough on its own. Nest instantiates a guard named in
 * `@UseGuards(...)` inside the module of the controller that names it, so everything a guard
 * injects has to be visible from all nine. MerchantScopeGuard needs `MerchantRepository` and
 * StaffGuard needs `StaffUsersService`; this module re-exports the two modules they come from,
 * which being global makes them resolvable everywhere a guard is.
 */
import { Global, Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { MerchantsModule } from '../merchants/merchants.module';
import { StaffModule } from '../staff/staff.module';

import { ApiKeyResolver } from './api-key/api-key.resolver';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { CheckoutSecretGuard } from './guards/checkout-secret.guard';
import { ClientSecretGuard } from './guards/client-secret.guard';
import { InternalServiceGuard } from './guards/internal-service.guard';
import { MerchantScopeGuard } from './guards/merchant-scope.guard';
import { ProcessorSignatureGuard } from './guards/processor-signature.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';
import { StaffGuard } from './guards/staff.guard';
import { PrincipalFactory } from './principal/principal.factory';
import { CsrfService } from './session/csrf.service';
import { RedisSessionStore } from './session/redis-session.store';
import { SessionService } from './session/session.service';
import { InMemorySessionStore, SESSION_STORE, type SessionStore } from './session/session.store';
import { StaffAuthController } from './staff-auth.controller';

const GUARDS = [
  ApiKeyGuard,
  SessionGuard,
  ClientSecretGuard,
  CheckoutSecretGuard,
  StaffGuard,
  InternalServiceGuard,
  RolesGuard,
  MerchantScopeGuard,
  RateLimitGuard,
  ProcessorSignatureGuard,
];

@Global()
@Module({
  imports: [CommonModule, MerchantsModule, StaffModule],
  controllers: [AuthController, StaffAuthController],
  providers: [
    PrincipalFactory,
    ApiKeyResolver,
    CsrfService,
    SessionService,
    AuthService,
    RedisSessionStore,
    {
      provide: SESSION_STORE,
      inject: [API_CONFIG, RedisSessionStore],
      useFactory: (config: ApiConfig, redis: RedisSessionStore): SessionStore =>
        config.runtime.nodeEnv === 'test' ? new InMemorySessionStore() : redis,
    },
    ...GUARDS,
  ],
  exports: [
    AuthService,
    SessionService,
    CsrfService,
    PrincipalFactory,
    ApiKeyResolver,
    SESSION_STORE,
    ...GUARDS,
    MerchantsModule,
    StaffModule,
  ],
})
export class AuthModule {}
