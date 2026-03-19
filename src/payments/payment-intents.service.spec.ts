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

    it('confirms in the same call when confirm=true', async () => {
      const created = makePaymentIntent();
      repo.insertIntent.mockResolvedValue(created as never);
      confirmFlow.execute.mockResolvedValue(
        makePaymentIntent({ id: created.id, status: 'succeeded' }) as never,
      );

      const result = await service.create(
        principal,
        makeCreatePaymentIntentRequest({ confirm: true }),
      );

      expect(confirmFlow.execute).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('succeeded');
    });

    it('stamps livemode from the principal, never from the request body', async () => {
      repo.insertIntent.mockResolvedValue(makePaymentIntent() as never);

      await service.create(makeApiKeyPrincipal({ mode: 'test' }), makeCreatePaymentIntentRequest());

      expect(repo.insertIntent).toHaveBeenCalledWith(
        expect.objectContaining({ livemode: false }),
      );
    });
  });

  describe('get', () => {
    it('reads scoped to the principal’s merchant', async () => {
      const intent = makePaymentIntent();
      repo.findScoped.mockResolvedValue(intent as never);

      await service.get(principal, intent.id);

      expect(repo.findScoped).toHaveBeenCalledWith(
        intent.id,
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID }),
      );
    });

    it('throws PaymentIntentNotFoundException when the row is not in scope', async () => {
      repo.findScoped.mockResolvedValue(null as never);

      await expect(service.get(principal, 'pi_someone_elses')).rejects.toBeInstanceOf(
        PaymentIntentNotFoundException,
      );
    });
  });

  describe('delegation to flows', () => {
    it('confirm() runs ConfirmPaymentFlow', async () => {
      const intent = makePaymentIntent();
      repo.findScoped.mockResolvedValue(intent as never);
      confirmFlow.execute.mockResolvedValue(intent as never);

      await service.confirm(principal, intent.id, { return_url: 'https://x.example' });

      expect(confirmFlow.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: intent.id }),
        expect.objectContaining({ return_url: 'https://x.example' }),
      );
      expect(captureFlow.execute).not.toHaveBeenCalled();
    });

    it('capture() runs CapturePaymentFlow', async () => {
      const intent = makeCapturablePaymentIntent();
      repo.findScoped.mockResolvedValue(intent as never);
      captureFlow.execute.mockResolvedValue(intent as never);

      await service.capture(principal, intent.id, { amount_minor: 4_500 });

      expect(captureFlow.execute).toHaveBeenCalledTimes(1);
    });

    it('cancel() runs CancelPaymentFlow', async () => {
      const intent = makePaymentIntent();
      repo.findScoped.mockResolvedValue(intent as never);
      cancelFlow.execute.mockResolvedValue(intent as never);

      await service.cancel(principal, intent.id, { cancellation_reason: 'abandoned' });

      expect(cancelFlow.execute).toHaveBeenCalledTimes(1);
    });

    it('404s before touching a flow when the intent is out of scope', async () => {
      repo.findScoped.mockResolvedValue(null as never);

      await expect(service.confirm(principal, 'pi_foreign', {})).rejects.toBeInstanceOf(
        PaymentIntentNotFoundException,
      );
      expect(confirmFlow.execute).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('paginates with the merchant filter applied', async () => {
      repo.paginateCursor.mockResolvedValue({
        data: [],
        next_cursor: null,
        has_more: false,
      } as never);

      await service.list(principal, { limit: 25, status: 'succeeded' });

      expect(repo.paginateCursor).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25 }),
        expect.objectContaining({ merchantId: TEST_MERCHANT_ID }),
        expect.anything(),
      );
    });

    it('caps an oversized limit rather than letting it through to the query', async () => {
      repo.paginateCursor.mockResolvedValue({
        data: [],
        next_cursor: null,
        has_more: false,
      } as never);

      await service.list(principal, { limit: 5_000 });

      const [, query] = repo.paginateCursor.mock.calls[0];
      expect((query as { limit: number }).limit).toBeLessThanOrEqual(100);
    });
  });
});
