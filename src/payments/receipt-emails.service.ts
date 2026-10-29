/**
 * The shopper's receipts. RFC platform-v2 §2 — `receipt` when a payment with a `receipt_email`
 * is captured, `refund_receipt` when a refund of one succeeds.
 *
 * Both are queued inside the transaction that records the money movement (EmailService writes
 * the outbox with the caller's manager), so a receipt goes out if and only if the capture or
 * refund committed. No receipt email, no receipt: a merchant integrating server-to-server
 * without a shopper email has opted out by omission.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CurrencyCode, Merchant, MerchantId } from '@payzeno/contracts';
import { formatMoney } from '@payzeno/contracts/money';
import type { EntityManager } from 'typeorm';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { MerchantRepository } from '../merchants/merchant.repository';
import { EmailService } from '../notifications/email/email.service';

import type { ChargeEntity } from './charge.entity';
import { PaymentIntentEntity } from './payment-intent.entity';

export interface RefundReceipt {
  merchantId: MerchantId;
  paymentIntentId: string;
  amountMinor: number;
  currency: CurrencyCode;
  livemode: boolean;
}

@Injectable()
export class ReceiptEmailsService {
  constructor(
    private readonly merchants: MerchantRepository,
    private readonly email: EmailService,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** The intent behind a charge, read in the caller's transaction. */
  intentOf(manager: EntityManager, paymentIntentId: string): Promise<PaymentIntentEntity | null> {
    return manager.getRepository(PaymentIntentEntity).findOne({ where: { id: paymentIntentId } });
  }

  async queueReceipt(
    manager: EntityManager,
    intent: PaymentIntentEntity,
    charge: ChargeEntity,
    merchant: Merchant,
    capturedAmountMinor: number,
    capturedAt: Date,
  ): Promise<void> {
    if (!intent.receipt_email) return;
    await this.email.queue(
      {
        template: 'receipt',
        to: intent.receipt_email,
        data: {
          merchant_name: merchant.display_name,
          amount: formatMoney({ amount_minor: capturedAmountMinor, currency: charge.currency }),
          description: intent.description,
          card_last4: charge.card_last_four,
          date: capturedAt.toISOString().slice(0, 10),
          payment_id: intent.id,
        },
        merchantId: merchant.id,
        livemode: charge.livemode,
      },
      manager,
    );
  }

  async queueRefundReceipt(manager: EntityManager, refund: RefundReceipt): Promise<void> {
    const intent = await this.intentOf(manager, refund.paymentIntentId);
    if (!intent?.receipt_email) return;

    const merchant = await this.merchants.findById(refund.merchantId);
    if (!merchant) {
      this.logger.warn('refund_receipt_merchant_missing', { merchant_id: refund.merchantId });
      return;
    }

    await this.email.queue(
      {
        template: 'refund_receipt',
        to: intent.receipt_email,
        data: {
          merchant_name: merchant.displayName,
          amount: formatMoney({ amount_minor: refund.amountMinor, currency: refund.currency }),
          payment_id: intent.id,
        },
        merchantId: refund.merchantId,
        livemode: refund.livemode,
      },
      manager,
    );
  }
}
