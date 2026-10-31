/**
 * The four subscription emails a merchant's customer gets. RFC platform-v2 §2/§6.
 *
 * Queued with the caller's manager, so each goes out exactly when the state change it describes
 * commits. Dates are `YYYY-MM-DD` (UTC) and amounts are `formatMoney` strings; the templates
 * render them as given. A customer without an email simply gets nothing.
 */
import { Injectable } from '@nestjs/common';
import { formatMoney } from '@payzeno/contracts/money';
import type { EntityManager } from 'typeorm';

import type { CustomerEntity } from '../../customers/customer.entity';
import { EmailService } from '../../notifications/email/email.service';

import type { PriceEntity } from './price.entity';
import type { SubscriptionEntity } from './subscription.entity';

export interface NoticeSubject {
  subscription: SubscriptionEntity;
  customer: CustomerEntity;
  price: PriceEntity;
  merchantName: string;
}

export function emailDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

@Injectable()
export class SubscriptionNotices {
  constructor(private readonly email: EmailService) {}

  started(manager: EntityManager, subject: NoticeSubject): Promise<void> {
    return this.send(manager, subject, 'subscription_started', {
      amount: this.amount(subject),
      period_end: emailDate(subject.subscription.currentPeriodEnd),
    });
  }

  renewed(manager: EntityManager, subject: NoticeSubject): Promise<void> {
    return this.send(manager, subject, 'subscription_renewed', {
      amount: this.amount(subject),
      period_end: emailDate(subject.subscription.currentPeriodEnd),
    });
  }

  paymentFailed(manager: EntityManager, subject: NoticeSubject, updateUrl: string, nextRetry: Date | null): Promise<void> {
    return this.send(manager, subject, 'subscription_payment_failed', {
      amount: this.amount(subject),
      update_url: updateUrl,
      next_retry: nextRetry ? emailDate(nextRetry) : null,
    });
  }

  canceled(manager: EntityManager, subject: NoticeSubject): Promise<void> {
    return this.send(manager, subject, 'subscription_canceled', {});
  }

  private amount(subject: NoticeSubject): string {
    return formatMoney({ amount_minor: Number(subject.price.unitAmountMinor), currency: subject.price.currency });
  }

  private async send(
    manager: EntityManager,
    subject: NoticeSubject,
    template: 'subscription_started' | 'subscription_renewed' | 'subscription_payment_failed' | 'subscription_canceled',
    data: Record<string, string | null>,
  ): Promise<void> {
    if (!subject.customer.email) return;
    await this.email.queue(
      {
        template,
        to: subject.customer.email,
        data: { merchant_name: subject.merchantName, product_name: subject.price.productName, ...data },
        merchantId: subject.subscription.merchantId,
        livemode: subject.subscription.livemode,
      },
      manager,
    );
  }
}
