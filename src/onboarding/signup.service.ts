/**
 * SignupService — `POST /v1/signup`, RFC platform-v2 §3.
 *
 * One transaction creates everything a self-serve merchant is:
 *
 *   MerchantOnboardingService.onboard   the merchant (`pending_review`), `merchant.created`, and
 *                                       the live AND test charts of accounts in the ledger — the
 *                                       same path the demo seed takes, so a signed-up merchant is
 *                                       indistinguishable from a seeded one except for its status
 *   OnboardingService.createFor         the `collecting` onboarding row
 *   MerchantUsersService.createUser     the owner, `invited`, holding the password they chose
 *   MerchantUserTokensService.issue     the 72h `email_verification` token
 *   EmailService.queue                  `signup_verify` with the link
 *
 * The owner cannot log in until they click the link (`POST /v1/signup/verify`, AuthService).
 * Test mode works from that moment; live payments wait for a reviewer.
 *
 * A signup does not need a global email check: `merchant_user.email` is unique per merchant on
 * purpose, and someone who already has a login elsewhere is simply a person with two logins.
 * What IS unique is the legal name per country, and that refusal comes from `onboard` as a 422
 * on `legal_name` before any of the above starts.
 */
import { Inject, Injectable } from '@nestjs/common';

import type { SignupRequest, SignupResponse } from '@payzeno/contracts';

import { hashPassword } from '../auth/auth.service';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { normaliseCountry } from '../common/money/currency.util';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { MerchantOnboardingService } from '../merchants/merchant-onboarding.service';
import { MerchantUserTokensService } from '../merchants/users/user-tokens.service';
import { MerchantUsersService } from '../merchants/users/users.service';
import { EmailService } from '../notifications/email/email.service';

import { OnboardingService } from './onboarding.service';

/**
 * Signup does not ask what the merchant sells in a way that maps to a category code, and
 * `merchant.mcc` is NOT NULL. 5999 (miscellaneous retail) is the acquirers' own placeholder;
 * risk sets the real one during review.
 */
export const SELF_SERVE_MCC = '5999';

@Injectable()
export class SignupService {
  constructor(
    private readonly merchantOnboarding: MerchantOnboardingService,
    private readonly onboarding: OnboardingService,
    private readonly users: MerchantUsersService,
    private readonly tokens: MerchantUserTokensService,
    private readonly email: EmailService,
    private readonly transactions: TransactionManager,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async signup(request: SignupRequest): Promise<SignupResponse> {
    // Before the transaction: argon2 is ~100ms and the ledger bootstrap is inside it already.
    const passwordHash = await hashPassword(request.password);
    const email = request.email.trim().toLowerCase();

    const created = await this.transactions.runInTransaction(async (manager) => {
      const merchant = await this.merchantOnboarding.onboard(
        {
          legal_name: request.legal_name,
          display_name: request.display_name,
          country: normaliseCountry(request.country),
          default_currency: request.default_currency,
          mcc: SELF_SERVE_MCC,
          metadata: { signup: 'self_serve' },
        },
        true,
        'signup',
        { manager, bootstrapTestMode: true },
      );

      await this.onboarding.createFor(merchant.id, manager);

      const owner = await this.users.createUser(
        merchant.id,
        { email, full_name: request.full_name, role: 'owner' },
        { status: 'invited', passwordHash },
        manager,
      );

      const token = await this.tokens.issue(owner, 'email_verification', manager);
      await this.email.queue(
        {
          template: 'signup_verify',
          to: email,
          data: {
            merchant_name: merchant.displayName,
            verify_url: `${this.config.publicUrls.console}/verify-email?token=${encodeURIComponent(token)}`,
          },
          merchantId: merchant.id,
        },
        manager,
      );

      return { merchantId: merchant.id, ownerId: owner.id };
    });

    this.logger.info('signup.created', { merchant_id: created.merchantId, user_id: created.ownerId });

    return { object: 'signup', merchant_id: created.merchantId, verification_required: true };
  }
}
