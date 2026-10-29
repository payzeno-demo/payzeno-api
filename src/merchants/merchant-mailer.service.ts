/**
 * MerchantMailerService — "tell the merchant": one email per active owner and admin.
 *
 * Every operational email to a merchant (RFC platform-v2 §2: onboarding decisions,
 * `dispute_opened`, `payout_paid` / `payout_failed`, `payment_review_opened`) goes to the same
 * people, carries the merchant's display name and links back into the console. This is the one
 * place that knows who those people are, so the dispute webhook, the ledger consumer and the
 * risk flow cannot each pick a slightly different audience.
 *
 * Developers and viewers are deliberately not on it: a dispute deadline sent to a contractor
 * who cannot submit evidence is a deadline nobody acts on.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { EmailTemplate, MerchantId, UserRole } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { EmailService, type QueueEmailInput } from '../notifications/email/email.service';

import { MerchantRepository } from './merchant.repository';
import { MerchantUserRepository } from './users/merchant-user.repository';

export const MERCHANT_NOTIFIED_ROLES: readonly UserRole[] = ['owner', 'admin'];

export interface MerchantMailOptions {
  /** The business transaction the email must commit with. */
  manager?: EntityManager;
  livemode?: boolean;
}

@Injectable()
export class MerchantMailerService {
  constructor(
    private readonly merchants: MerchantRepository,
    private readonly users: MerchantUserRepository,
    private readonly email: EmailService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Queues `template` to every active owner and admin. `merchant_name` and `console_url` are
   * filled in unless `data` already says otherwise. Returns how many emails were queued; zero
   * is logged, not thrown — a merchant whose only owner was removed still has a dispute.
   */
  async queueToAdmins(
    merchantId: MerchantId,
    template: EmailTemplate,
    data: QueueEmailInput['data'],
    options: MerchantMailOptions = {},
  ): Promise<number> {
    const merchant = await this.merchants.findById(merchantId, options.manager);
    const recipients = await this.users.listActiveByRoles(merchantId, MERCHANT_NOTIFIED_ROLES, options.manager);

    if (!merchant || recipients.length === 0) {
      this.logger.warn('merchant_mail.no_recipients', {
        merchant_id: merchantId,
        template,
        merchant_found: merchant !== null,
      });
      return 0;
    }

    const merged: QueueEmailInput['data'] = {
      merchant_name: merchant.displayName,
      console_url: this.config.publicUrls.console,
      ...data,
    };

    for (const recipient of recipients) {
      await this.email.queue(
        { template, to: recipient.email, data: merged, merchantId, livemode: options.livemode ?? true },
        options.manager,
      );
    }
    return recipients.length;
  }

  /** `${CONSOLE_PUBLIC_URL}${path}` — the console's own route table (`payzeno-console/src/routes.ts`). */
  consoleLink(path: string): string {
    return `${this.config.publicUrls.console}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
