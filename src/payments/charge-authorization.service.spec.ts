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
  let router: jest.Mocked<ProcessorRouter>;
  let publisher: jest.Mocked<OutboxEventPublisher>;
  let adapter: { acquirer: 'worldflow'; authorize: jest.Mock };

  const intent = makePaymentIntent();

  it('resolves the payment method token at the vault exactly once', async () => {
    await service.authorize(merchant, intent, { payment_method_token: 'pmt_visa_4242' });

    expect(vault.resolve).toHaveBeenCalledTimes(1);
    expect(vault.resolve).toHaveBeenCalledWith('pmt_visa_4242');
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

});
