import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';

import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { PaymentIntentNotFoundException } from 'src/common/errors/not-found.exceptions';
import { CancelPaymentFlow } from 'src/payments/flows/cancel-payment.flow';
import { CapturePaymentFlow } from 'src/payments/flows/capture-payment.flow';
import { ConfirmPaymentFlow } from 'src/payments/flows/confirm-payment.flow';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentsService } from 'src/payments/payment-intents.service';

import { makeApiKeyPrincipal } from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';
import {
  makeCapturablePaymentIntent,
  makeCreatePaymentIntentRequest,
  makePaymentIntent,
} from 'test/factories/payment-intent.factory';

/**
 * The product's centre of gravity (blueprint §9.3 — the hottest service file in the
 * repo). It is deliberately thin: every multi-aggregate operation delegates to a
 * `PaymentFlow`, so what this spec asserts is *routing and scoping*, not payment logic.
 * The payment logic is tested where it lives, in the flow specs.
 */
describe('PaymentIntentsService', () => {
  let service: PaymentIntentsService;
  let repo: jest.Mocked<PaymentIntentRepository>;
  let confirmFlow: jest.Mocked<ConfirmPaymentFlow>;
  let captureFlow: jest.Mocked<CapturePaymentFlow>;
  let cancelFlow: jest.Mocked<CancelPaymentFlow>;

  const principal = makeApiKeyPrincipal({ merchant_id: TEST_MERCHANT_ID });

  beforeEach(async () => {
    repo = {
      findScoped: jest.fn(),
      paginateCursor: jest.fn(),
      insertIntent: jest.fn(),
      updateScoped: jest.fn(),
    } as unknown as jest.Mocked<PaymentIntentRepository>;

    confirmFlow = { execute: jest.fn() } as unknown as jest.Mocked<ConfirmPaymentFlow>;
    captureFlow = { execute: jest.fn() } as unknown as jest.Mocked<CapturePaymentFlow>;
    cancelFlow = { execute: jest.fn() } as unknown as jest.Mocked<CancelPaymentFlow>;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentIntentsService,
        { provide: PaymentIntentRepository, useValue: repo },
        { provide: ConfirmPaymentFlow, useValue: confirmFlow },
        { provide: CapturePaymentFlow, useValue: captureFlow },
        { provide: CancelPaymentFlow, useValue: cancelFlow },
        { provide: PayzenoLogger, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(PaymentIntentsService);
  });

  it('names its entity, as BaseService requires', () => {
    expect(service.entityName).toBe('payment_intent');
  });

  describe('create', () => {
    it('persists a new intent in requires_confirmation with a client secret', async () => {
      const created = makePaymentIntent();
      repo.insertIntent.mockResolvedValue(created as never);

      const result = await service.create(principal, makeCreatePaymentIntentRequest());

      expect(repo.insertIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          merchant_id: TEST_MERCHANT_ID,
          amount_minor: 4_500,
          currency: 'GBP',
          status: 'requires_confirmation',
        }),
      );
      expect(result.client_secret).toEqual(expect.any(String));
    });

    it('starts in requires_payment_method when no token is supplied', async () => {
      repo.insertIntent.mockResolvedValue(
        makePaymentIntent({ status: 'requires_payment_method' }) as never,
      );

      await service.create(
        principal,
        makeCreatePaymentIntentRequest({ payment_method_token: undefined }),
      );

      expect(repo.insertIntent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'requires_payment_method' }),
      );
    });

  });
});
