import { Test } from '@nestjs/testing';

import { NoopLogger, PAYZENO_LOGGER } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { CapturePaymentFlow } from 'src/payments/flows/capture-payment.flow';
import { ChargeCaptureService } from 'src/payments/charge-capture.service';
import { LedgerHttpClient } from 'src/ledger/ledger-http.client';
import { MerchantsService } from 'src/merchants/merchants.service';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';

import { makeCapturedCharge } from 'test/factories/charge.factory';
import { makeMerchant } from 'test/factories/merchant.factory';
import { makeCapturablePaymentIntent, makePaymentIntent } from 'test/factories/payment-intent.factory';

/**
 * Frame 3 of the nine-frame chain. The flow's job: transaction boundary, FSM transition,
 * and a ledger posting — in that order, and all three or none.
 */
describe('CapturePaymentFlow', () => {
  let flow: CapturePaymentFlow;
  let capture: jest.Mocked<ChargeCaptureService>;
  let repo: jest.Mocked<PaymentIntentRepository>;
  let ledger: jest.Mocked<LedgerHttpClient>;
  let runInTransaction: jest.Mock;

  beforeEach(async () => {
    capture = {
      captureCharge: jest.fn().mockResolvedValue(makeCapturedCharge()),
    } as unknown as jest.Mocked<ChargeCaptureService>;

    repo = {
      updateScoped: jest.fn().mockImplementation(async (id: string, patch: object) =>
        makePaymentIntent({ id, ...(patch as object) }),
      ),
    } as unknown as jest.Mocked<PaymentIntentRepository>;

    ledger = {
      postTransaction: jest.fn().mockResolvedValue({ id: 'ltx_1' }),
    } as unknown as jest.Mocked<LedgerHttpClient>;

    runInTransaction = jest
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb({}));

    const moduleRef = await Test.createTestingModule({
      providers: [
        CapturePaymentFlow,
        PaymentIntentStateMachine,
        { provide: ChargeCaptureService, useValue: capture },
        { provide: PaymentIntentRepository, useValue: repo },
        { provide: LedgerHttpClient, useValue: ledger },
        { provide: MerchantsService, useValue: { getById: jest.fn().mockResolvedValue(makeMerchant()) } },
        { provide: TransactionManager, useValue: { runInTransaction } },
        { provide: PAYZENO_LOGGER, useValue: new NoopLogger() },
      ],
    }).compile();

    flow = moduleRef.get(CapturePaymentFlow);
  });

  it('captures the full authorised amount when none is given', async () => {
    const intent = makeCapturablePaymentIntent({ amount_minor: 4_500 });

    await flow.execute(intent, {});

    expect(capture.captureCharge).toHaveBeenCalledWith(expect.anything(), intent.latest_charge_id, 4_500);
  });

  it('captures a partial amount when one is given', async () => {
    const intent = makeCapturablePaymentIntent({ amount_minor: 4_500 });

    await flow.execute(intent, { amount_minor: 2_000 });

    expect(capture.captureCharge).toHaveBeenCalledWith(expect.anything(), intent.latest_charge_id, 2_000);
  });

  it('moves the intent to succeeded', async () => {
    const result = await flow.execute(makeCapturablePaymentIntent(), {});

    expect(result.status).toBe('succeeded');
  });

  it('runs everything inside one transaction', async () => {
    await flow.execute(makeCapturablePaymentIntent(), {});

    expect(runInTransaction).toHaveBeenCalledTimes(1);
  });

  it('posts the capture to the ledger with a deterministic idempotency key', async () => {
    const intent = makeCapturablePaymentIntent();

    await flow.execute(intent, {});

    expect(ledger.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: expect.any(String),
        reference_type: 'charge',
        reference_id: intent.latest_charge_id,
        idempotency_key: expect.stringContaining(intent.latest_charge_id as string),
      }),
    );
  });

  it('refuses to capture an intent that is not in requires_capture', async () => {
    await expect(flow.execute(makePaymentIntent({ status: 'succeeded' }), {})).rejects.toThrow();
    expect(capture.captureCharge).not.toHaveBeenCalled();
  });

  it('refuses when the intent has no charge', async () => {
    await expect(
      flow.execute(makeCapturablePaymentIntent({ latest_charge_id: null }), {}),
    ).rejects.toThrow();
  });

  it('does not update the intent when the capture throws', async () => {
    capture.captureCharge.mockRejectedValue(new Error('acquirer said no'));

    await expect(flow.execute(makeCapturablePaymentIntent(), {})).rejects.toThrow();

    const statuses = repo.updateScoped.mock.calls.map(
      ([, patch]) => (patch as { status?: string }).status,
    );
    expect(statuses).not.toContain('succeeded');
  });
});
