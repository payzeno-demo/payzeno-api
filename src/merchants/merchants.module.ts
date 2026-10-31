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
 *   MerchantUserTokensService  AuthService (verify / accept / reset) and signup — the emailed
 *                           links of RFC platform-v2 §3-§4
 *   MerchantMailerService   every "tell the merchant's owners and admins" email: onboarding
 *                           decisions, `dispute_opened`, payouts, risk reviews
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyHasher } from '../auth/api-key/api-key.hasher';
import { CommonModule } from '../common/common.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';

import { ApiKeyEntity } from './api-keys/api-key.entity';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { ApiKeyRepository, ApiKeysService } from './api-keys/api-keys.service';
import { BankAccountEntity } from './bank-accounts/bank-account.entity';
import { BankAccountsController } from './bank-accounts/bank-accounts.controller';
import { BankAccountRepository, BankAccountsService } from './bank-accounts/bank-accounts.service';
import { MerchantMailerService } from './merchant-mailer.service';
import { MerchantOnboardingService } from './merchant-onboarding.service';
import { MerchantStatusStateMachine } from './merchant-status.state-machine';
import { MerchantEntity } from './merchant.entity';
import { MerchantRepository } from './merchant.repository';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';
import { DisputeRateCalculator } from './risk/dispute-rate.calculator';
import { MerchantUserTokenEntity } from './users/merchant-user-token.entity';
import { MerchantUserTokenRepository } from './users/merchant-user-token.repository';
import { MerchantUserEntity } from './users/merchant-user.entity';
import { MerchantUserRepository } from './users/merchant-user.repository';
import { MerchantUserTokensService } from './users/user-tokens.service';
import { MerchantUsersController } from './users/users.controller';
import { MerchantUsersService } from './users/users.service';

@Module({
  imports: [
    CommonModule,
    LedgerModule,
    EventsModule,
    TypeOrmModule.forFeature([
      MerchantEntity,
      MerchantUserEntity,
      MerchantUserTokenEntity,
      ApiKeyEntity,
      BankAccountEntity,
    ]),
  ],
  controllers: [
    MerchantsController,
    MerchantUsersController,
    ApiKeysController,
    BankAccountsController,
  ],
  providers: [
    MerchantRepository,
    MerchantUserRepository,
    ApiKeyRepository,
    BankAccountRepository,
    MerchantStatusStateMachine,
    MerchantOnboardingService,
    MerchantsService,
    MerchantUsersService,
    MerchantUserTokenRepository,
    MerchantUserTokensService,
    MerchantMailerService,
    ApiKeysService,
    BankAccountsService,
    ApiKeyHasher,
    DisputeRateCalculator,
    /**
     * `RiskEvaluationService` is NOT provided here. It reaches into ChargeRepository and
     * DisputeRepository, which live in PaymentsModule and DisputesModule — both of which import
     * this one — so it is provided by `JobsModule`, which imports all three, and the graph
     * stays a DAG. Provided here, it cannot see ChargeRepository and the app does not boot.
     */
  ],
  exports: [
    MerchantsService,
    MerchantOnboardingService,
    MerchantUsersService,
    MerchantUserTokensService,
    MerchantMailerService,
    ApiKeysService,
    BankAccountsService,
    MerchantRepository,
    MerchantUserRepository,
    ApiKeyRepository,
    BankAccountRepository,
    MerchantStatusStateMachine,
    DisputeRateCalculator,
    ApiKeyHasher,
    TypeOrmModule,
  ],
})
export class MerchantsModule {}
