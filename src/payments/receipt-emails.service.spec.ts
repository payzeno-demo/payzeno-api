import type { Merchant } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import type { EmailService, QueueEmailInput } from 'src/notifications/email/email.service';
import { ChargeEntity } from 'src/payments/charge.entity';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import { ReceiptEmailsService } from 'src/payments/receipt-emails.service';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('ReceiptEmailsService', () => {
  let emails: Array<{ input: QueueEmailInput; manager: EntityManager | undefined }>;
  let intent: PaymentIntentEntity | null;
  const manager = stub<EntityManager>({
    getRepository: jest.fn(() => ({ findOne: jest.fn(async () => intent) })) as EntityManager['getRepository'],
  });

  function service(): ReceiptEmailsService {
    return new ReceiptEmailsService(
      stub<MerchantRepository>({
        findById: jest.fn(async () => Object.assign(new MerchantEntity(), { displayName: 'Kumo Tea House' })),
      }),
      stub<EmailService>({
        queue: jest.fn(async (input: QueueEmailInput, m?: EntityManager) => {
          emails.push({ input, manager: m });
        }),
      }),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    emails = [];
    intent = Object.assign(new PaymentIntentEntity(), {
      id: 'pi_1',
      receipt_email: 'shopper@example.com',
      description: 'Tea Club',
    });
  });

  it('queues the receipt in the capture transaction', async () => {
    const charge = Object.assign(new ChargeEntity(), { currency: 'JPY', card_last_four: '4242', livemode: true });
    await service().queueReceipt(
      manager,
      intent as PaymentIntentEntity,
      charge,
      stub<Merchant>({ id: 'mch_1', display_name: 'Kumo Tea House' }),
      3_000,
      new Date('2026-10-29T09:00:00.000Z'),
    );

    expect(emails).toEqual([
      {
        manager,
        input: {
          template: 'receipt',
          to: 'shopper@example.com',
          data: {
            merchant_name: 'Kumo Tea House',
            amount: '¥3,000',
            description: 'Tea Club',
            card_last4: '4242',
            date: '2026-10-29',
            payment_id: 'pi_1',
          },
          merchantId: 'mch_1',
          livemode: true,
        },
      },
    ]);
  });

  it('sends nothing when the payment has no receipt email', async () => {
    intent = Object.assign(new PaymentIntentEntity(), { id: 'pi_1', receipt_email: null });
    await service().queueReceipt(manager, intent, new ChargeEntity(), stub<Merchant>({}), 100, new Date());
    await service().queueRefundReceipt(manager, { merchantId: 'mch_1', paymentIntentId: 'pi_1', amountMinor: 100, currency: 'USD', livemode: true });
    expect(emails).toHaveLength(0);
  });

  it('queues the refund receipt to the payment’s receipt email', async () => {
    await service().queueRefundReceipt(manager, {
      merchantId: 'mch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 1_000,
      currency: 'JPY',
      livemode: false,
    });

    expect(emails[0].input).toEqual({
      template: 'refund_receipt',
      to: 'shopper@example.com',
      data: { merchant_name: 'Kumo Tea House', amount: '¥1,000', payment_id: 'pi_1' },
      merchantId: 'mch_1',
      livemode: false,
    });
  });
});
