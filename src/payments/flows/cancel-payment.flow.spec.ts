import { Test } from '@nestjs/testing';

import { NoopLogger, PAYZENO_LOGGER } from 'src/common/logging/logger';
import { CLOCK } from 'src/common/time/clock';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { EVENT_PUBLISHER } from 'src/events/publisher';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';
import { CancelPaymentFlow } from 'src/payments/flows/cancel-payment.flow';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ChargeStateMachine } from 'src/payments/state/charge.state-machine';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';
import { ProcessorRouter } from 'src/payments/processor/processor.router';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * The void path. The rule this spec exists to pin down is the one people get wrong:
 * cancelling an authorised charge is a VOID, and a void creates no `Refund` row
 * (domain-model §4). If this suite ever grows an assertion about a refund, something has
 * gone badly wrong upstream of it.
 */
describe('CancelPaymentFlow', () => {
  let flow: CancelPaymentFlow;
  let intents: jest.Mocked<PaymentIntentRepository>;
  let charges: jest.Mocked<ChargeRepository>;
  let ledger: jest.Mocked<LedgerReadThroughService>;
  let publish: jest.Mock;
  let adapter: { void: jest.Mock };

  function intentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pi_cancel_1',
      merchantId: 'mch_test01',
      status: 'requires_capture',
      currency: 'GBP',
      amount_minor: 4_500,
      latest_charge_id: 'ch_cancel_1',
      livemode: true,
      ...overrides,
    } as never;
  }

  function chargeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ch_cancel_1',
      merchantId: 'mch_test01',
      status: 'authorized',
      acquirer: 'worldflow',
      currency: 'GBP',
      amount_minor: 4_500,
      network_transaction_id: 'ntx_1',
      livemode: true,
      ...overrides,
    } as never;
  }

  beforeEach(async () => {
    adapter = { void: jest.fn().mockResolvedValue({ voided: true, processorReference: 'wf_void_1' }) };
    publish = jest.fn().mockResolvedValue('evt_1');

    intents = {
      transitionStatus: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<PaymentIntentRepository>;

    charges = {
      findOne: jest.fn().mockResolvedValue(chargeRow()),
      markVoided: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<ChargeRepository>;

    ledger = {
      releaseAuthorization: jest.fn().mockResolvedValue({ id: 'txn_1' }),
    } as unknown as jest.Mocked<LedgerReadThroughService>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        CancelPaymentFlow,
        PaymentIntentStateMachine,
        ChargeStateMachine,
        { provide: PaymentIntentRepository, useValue: intents },
        { provide: ChargeRepository, useValue: charges },
        { provide: ProcessorRouter, useValue: { forAcquirer: () => adapter } },
        { provide: LedgerReadThroughService, useValue: ledger },
        { provide: EVENT_PUBLISHER, useValue: { publish } },
        { provide: CLOCK, useValue: new FixedClock('2026-01-15T12:00:00.000Z') },
        {
          provide: TransactionManager,
          useValue: {
            runInTransaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})),
          },
        },
        { provide: PAYZENO_LOGGER, useValue: new NoopLogger() },
      ],
    }).compile();

    flow = moduleRef.get(CancelPaymentFlow);
  });

  it('voids the authorisation at the acquirer that holds it', async () => {
    await flow.execute(intentRow(), {});

    expect(adapter.void).toHaveBeenCalledWith(
      expect.objectContaining({ networkTransactionId: 'ntx_1' }),
    );
    expect(charges.markVoided).toHaveBeenCalled();
  });

  it('sends a deterministic idempotency key with the void', async () => {
    await flow.execute(intentRow(), {});

    const [req] = adapter.void.mock.calls[0];
    expect((req as { idempotencyKey: string }).idempotencyKey).toContain('ch_cancel_1');
  });

  it('moves the intent to canceled and stamps the reason', async () => {
    const result = await flow.execute(intentRow(), { cancellation_reason: 'abandoned' });

    expect(result.status).toBe('canceled');
    expect(result.cancellation_reason).toBe('abandoned');
  });

  it('defaults the reason to requested_by_customer', async () => {
    const result = await flow.execute(intentRow(), {});

    expect(result.cancellation_reason).toBe('requested_by_customer');
  });

  it('emits payment.canceled with the released amount', async () => {
    await flow.execute(intentRow(), {});

    expect(publish).toHaveBeenCalledWith(
      'payment.canceled',
      expect.objectContaining({ released_amount_minor: 4_500, charge_id: 'ch_cancel_1' }),
      expect.anything(),
    );
  });

  it('posts the auth_release to the ledger only when a hold was actually released', async () => {
    await flow.execute(intentRow(), {});

    expect(ledger.releaseAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ chargeId: 'ch_cancel_1', amountMinor: 4_500 }),
    );
  });

  it('cancels an intent that never reached an acquirer without calling one', async () => {
    charges.findOne.mockResolvedValue(null as never);

    const result = await flow.execute(
      intentRow({ status: 'requires_confirmation', latest_charge_id: null }),
      {},
    );

    expect(adapter.void).not.toHaveBeenCalled();
    expect(ledger.releaseAuthorization).not.toHaveBeenCalled();
    expect(result.status).toBe('canceled');
  });

  it('does not void a charge that is already captured', async () => {
    charges.findOne.mockResolvedValue(chargeRow({ status: 'captured' }) as never);

    await flow.execute(intentRow(), {});

    // A captured charge is refunded, never voided — two different network calls.
    expect(adapter.void).not.toHaveBeenCalled();
  });

  it('still cancels the intent when the acquirer refuses the void', async () => {
    adapter.void.mockResolvedValue({ voided: false, processorReference: '' });

    const result = await flow.execute(intentRow(), {});

    expect(result.status).toBe('canceled');
    expect(ledger.releaseAuthorization).not.toHaveBeenCalled();
  });

  it('refuses to cancel a terminal intent', async () => {
    await expect(flow.execute(intentRow({ status: 'succeeded' }), {})).rejects.toThrow();
    expect(adapter.void).not.toHaveBeenCalled();
  });
});
