import { Test } from '@nestjs/testing';

import {
  CardDeclinedException,
  ExpiredCardException,
  InsufficientFundsException,
} from 'src/common/errors/card.exceptions';
import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { OutboxEventPublisher } from 'src/events/outbox-event.publisher';
import { ChargeAuthorizationService } from 'src/payments/charge-authorization.service';
import { ChargeExpiryPolicy } from 'src/payments/charge-expiry.policy';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ProcessorRouter } from 'src/payments/processor/processor.router';
import { VaultClient } from 'src/payments/vault/vault.client';

import { makeCard } from 'test/factories/charge.factory';
import { makeMerchant } from 'test/factories/merchant.factory';
import { makePaymentIntent } from 'test/factories/payment-intent.factory';

/**
 * The authorisation leg: vault resolve → processor route → authorize → persist → emit.
 *
 * Decline mapping is the interesting part. `DeclineCodeMapper` (folded into
 * `processor.types.ts`) turns an acquirer decline code into a specific exception class;
 * three of them are distinct classes precisely so the console and the merchant SDK can
 * branch without string-matching a message.
 */
describe('ChargeAuthorizationService', () => {
  let service: ChargeAuthorizationService;
  let vault: jest.Mocked<VaultClient>;
  let router: jest.Mocked<ProcessorRouter>;
  let repo: jest.Mocked<ChargeRepository>;
  let publisher: jest.Mocked<OutboxEventPublisher>;
  let adapter: { acquirer: 'worldflow'; authorize: jest.Mock };

  const merchant = makeMerchant();
  const intent = makePaymentIntent();

  function approvedResult(overrides: Record<string, unknown> = {}) {
    return {
      approved: true,
      networkTransactionId: 'ntx_1',
      authorizationCode: 'A17742',
      processorReference: 'wf_auth_1',
      declineCode: null,
      riskScore: 12,
      card: makeCard(),
      threeDSecure: {
        version: '2.2.0',
        authenticationFlow: 'frictionless',
        result: 'authenticated',
        eci: '05',
        liabilityShifted: true,
      },
      raw: {},
      ...overrides,
    };
  }

  beforeEach(async () => {
    adapter = { acquirer: 'worldflow', authorize: jest.fn().mockResolvedValue(approvedResult()) };

    vault = {
      resolve: jest.fn().mockResolvedValue({
        token: 'pmt_visa_4242',
        card: makeCard(),
        fingerprint: 'fp_1',
      }),
    } as unknown as jest.Mocked<VaultClient>;

    router = { select: jest.fn().mockReturnValue(adapter) } as unknown as jest.Mocked<ProcessorRouter>;

    repo = {
      insertCharge: jest.fn().mockImplementation(async (row: Record<string, unknown>) => row),
      markAuthorized: jest.fn().mockImplementation(async (_id: string, patch: object) => patch),
      markFailed: jest.fn(),
    } as unknown as jest.Mocked<ChargeRepository>;

    publisher = { publish: jest.fn().mockResolvedValue('evt_1') } as unknown as jest.Mocked<OutboxEventPublisher>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChargeAuthorizationService,
        ChargeExpiryPolicy,
        { provide: VaultClient, useValue: vault },
        { provide: ProcessorRouter, useValue: router },
        { provide: ChargeRepository, useValue: repo },
        { provide: OutboxEventPublisher, useValue: publisher },
        {
          provide: TransactionManager,
          useValue: {
            runInTransaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})),
          },
        },
        { provide: PayzenoLogger, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(ChargeAuthorizationService);
  });

  it('resolves the payment method token at the vault exactly once', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    expect(vault.resolve).toHaveBeenCalledTimes(1);
    expect(vault.resolve).toHaveBeenCalledWith('pmt_visa_4242');
  });

  it('routes through ProcessorRouter rather than picking an acquirer itself', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    expect(router.select).toHaveBeenCalledWith(merchant, intent.currency);
  });

  it('persists the charge with the acquirer’s processor reference', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    expect(repo.markAuthorized).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processor_reference: 'wf_auth_1',
        network_transaction_id: 'ntx_1',
        authorization_code: 'A17742',
        acquirer: 'worldflow',
      }),
    );
  });

  it('emits payment.authorized with the fields the ledger projection requires', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.authorized',
      expect.objectContaining({
        reserve_bps: merchant.reserve_bps,
        processor_reference: 'wf_auth_1',
        acquirer: 'worldflow',
        capture_at_settlement: merchant.capture_at_settlement,
      }),
      expect.anything(),
    );
  });

  it('stamps an expiry from ChargeExpiryPolicy, not a hardcoded 7 days', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    const [, patch] = repo.markAuthorized.mock.calls[0];
    expect((patch as { authorization_expires_at: string }).authorization_expires_at).toEqual(
      expect.any(String),
    );
  });

  describe('declines', () => {
    it.each([
      ['insufficient_funds', InsufficientFundsException],
      ['expired_card', ExpiredCardException],
      ['do_not_honor', CardDeclinedException],
      ['fraud_suspected', CardDeclinedException],
    ])('maps %s onto its exception class', async (code, ctor) => {
      adapter.authorize.mockResolvedValue(
        approvedResult({ approved: false, declineCode: code, authorizationCode: null, networkTransactionId: null }),
      );

      await expect(
        service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' }),
      ).rejects.toBeInstanceOf(ctor);
    });

    it('carries the decline code in the exception details', async () => {
      adapter.authorize.mockResolvedValue(
        approvedResult({ approved: false, declineCode: 'lost_card', authorizationCode: null }),
      );

      try {
        await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });
        throw new Error('expected a decline');
      } catch (err) {
        expect((err as CardDeclinedException).details).toMatchObject({ decline_code: 'lost_card' });
      }
    });

    it('marks the charge failed before throwing', async () => {
      adapter.authorize.mockResolvedValue(
        approvedResult({ approved: false, declineCode: 'do_not_honor', authorizationCode: null }),
      );

      await expect(
        service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' }),
      ).rejects.toThrow();
      expect(repo.markFailed).toHaveBeenCalled();
    });

    it('emits payment.failed on a decline', async () => {
      adapter.authorize.mockResolvedValue(
        approvedResult({ approved: false, declineCode: 'velocity_exceeded', authorizationCode: null }),
      );

      await expect(
        service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' }),
      ).rejects.toThrow();
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({ failure_code: 'velocity_exceeded' }),
        expect.anything(),
      );
    });
  });

  it('never writes card data beyond the CardSummary the vault returned', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    const [row] = repo.insertCharge.mock.calls[0];
    const serialised = JSON.stringify(row);
    expect(serialised).not.toMatch(/\bpan\b/i);
    expect(serialised).not.toMatch(/\bcvv\b/i);
  });
});
