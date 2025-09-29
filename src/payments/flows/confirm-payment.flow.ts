/**
 * ConfirmPaymentFlow — chain F of the blueprint, the deepest read-write path in the repo:
 *
 *   PaymentIntentsController.confirm → PaymentIntentsService.confirm → **ConfirmPaymentFlow**
 *   → PaymentIntentStateMachine.apply → ChargeAuthorizationService.authorize
 *   → VaultClient.resolve → ProcessorRouter.select → NordpayAdapter.authorize
 *   → AcquirerHttpClient.post → BaseHttpClient.request → UndiciTransport.send
 *
 * Ordering, and why:
 *   1. `requires_confirmation → processing` is written BEFORE the acquirer call. A confirm
 *      that crashes mid-authorisation must not look confirmable to the next request.
 *   2. The acquirer call happens outside a transaction. Holding a row lock across a network
 *      call to a system that once took 22 minutes to answer is PAY-2041's other lesson.
 *   3. The landing transition (`succeeded` / `requires_capture` / `requires_action` /
 *      `failed`) is written in its own transaction from the acquirer's answer.
 */

import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { ConfirmPaymentIntentRequest, NextAction, PaymentMethodToken } from '@payzeno/contracts';

import { ValidationException } from '../../common/errors/api.exception';
import { CardDeclinedException, isRetryableDecline } from '../../common/errors/card.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { MerchantsService, toMerchantResponse } from '../../merchants/merchants.service';
import { ChargeAuthorizationService } from '../charge-authorization.service';
import { PaymentIntentEntity } from '../payment-intent.entity';
import { PaymentIntentRepository } from '../payment-intent.repository';
import { PaymentIntentStateMachine, type PaymentIntentEvent } from '../state/payment-intent.state-machine';
import { PaymentFlow } from './payment.flow';

@Injectable()
export class ConfirmPaymentFlow extends PaymentFlow<ConfirmPaymentIntentRequest> {
  constructor(
    intents: PaymentIntentRepository,
    states: PaymentIntentStateMachine,
    transactions: TransactionManager,
    private readonly authorization: ChargeAuthorizationService,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(intents, states, transactions, logger);
  }

  get flowName(): string {
    return 'payment_intent.confirm';
  }

  protected get entryEvent(): PaymentIntentEvent {
    return 'confirm';
  }

  async execute(
    intent: PaymentIntentEntity,
    request: ConfirmPaymentIntentRequest,
  ): Promise<PaymentIntentEntity> {
    const token = (request.payment_method_token ?? intent.payment_method_token) as PaymentMethodToken | null;
    if (!token) {
      throw new ValidationException('A payment method is required to confirm this intent', [
        { path: 'payment_method_token', code: 'required', message: 'no payment method on the intent' },
      ]);
    }

    // Step 2 — the acquirer round trip. Outside any transaction, on purpose.
    let outcome: Awaited<ReturnType<ChargeAuthorizationService['authorize']>>;
    try {
      outcome = await this.authorization.authorize({
        merchant,
        paymentIntentId: intent.id,
        amountMinor: Number(intent.amount_minor),
        currency: intent.currency,
        paymentMethodToken: token,
        captureMethod: intent.capture_method,
        statementDescriptor: intent.statement_descriptor,
        threeDSecure: request.return_url
          ? { returnUrl: request.return_url, challengePreference: 'auto' }
          : null,
        livemode: intent.livemode,
        correlationId: intent.id,
      });
    } catch (err) {
      await this.landOnFailure(intent, err);
      throw err;
    }

    // Step 3 — land it.
    if (outcome.requiresAction) {
      return this.landOnAction(intent, request.return_url ?? null, outcome.charge.id);
    }

    const status = this.states.apply('processing', event);

    await this.transactions.runInTransaction(async (manager) => {
      await this.intents.transitionStatus(manager, intent.id, 'processing', status, { next_action: null });
    });

    intent.status = status;

    this.logger.warn('payment_intent_confirm_failed', {
      payment_intent_id: intent.id,
      landed_in: status,
      retryable,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}
