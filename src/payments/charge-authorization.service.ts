/**
 * Authorisation. L7-adjacent application service, reached from `ConfirmPaymentFlow`.
 *
 * The chain this file sits in (blueprint §2.1, chain F):
 *   PaymentIntentsController.confirm → PaymentIntentsService.confirm → ConfirmPaymentFlow.execute
 *   → **ChargeAuthorizationService.authorize** → VaultClient.resolve → ProcessorRouter.select
 *   → NordpayAdapter.authorize → AcquirerHttpClient.postJson → BaseHttpClient.request
 *
 * Two rules this file exists to keep:
 *  - the charge row is written BEFORE the acquirer call, in `pending`, so a timeout leaves a
 *    row to reconcile against instead of an authorisation nobody in Payzeno has heard of;
 *  - `payment.authorized` is published through the OUTBOX, inside the same transaction as the
 *    status write. A direct SNS publish here would emit an authorisation for a charge whose
 *    row rolled back. ADR 0011.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Acquirer, ChargeId, Merchant, PaymentMethodToken } from '@payzeno/contracts';

import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { API_ID_PREFIXES } from '../common/ids/id.prefix';
import { IdFactory } from '../common/ids/id.factory';
import { CLOCK, type Clock } from '../common/time/clock';
import { LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CardDeclinedException, ExpiredCardException, InsufficientFundsException } from '../common/errors/card.exceptions';
import { ChargeExpiryPolicy } from './charge-expiry.policy';
import { ChargeEntity } from './charge.entity';
import { ChargeRepository } from './charge.repository';
import { ProcessorRouter } from './processor/processor.router';
import { isRetryableDecline, type AuthorizeResult, type ThreeDSecureRequest } from './processor/processor.types';
import { VaultClient } from './vault/vault.client';

export interface AuthorizeChargeCommand {
  merchant: Merchant;
  paymentIntentId: string;
  amountMinor: number;
  currency: Merchant['default_currency'];
  paymentMethodToken: PaymentMethodToken;
  captureMethod: 'automatic' | 'manual';
  statementDescriptor: string | null;
  threeDSecure: ThreeDSecureRequest | null;
  livemode: boolean;
  correlationId: string;
}

export interface AuthorizationOutcome {
  charge: ChargeEntity;
  result: AuthorizeResult;
  /** True when the issuer demanded SCA; the intent moves to `requires_action`. */
  requiresAction: boolean;
}

@Injectable()
export class ChargeAuthorizationService {
  constructor(
    private readonly charges: ChargeRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    const chargeId = this.ids.generate(API_ID_PREFIXES.charge) as ChargeId;

    let result: AuthorizeResult;
    try {
      result = await adapter.authorize({
        chargeId,
        merchantId: command.merchant.id,
        amountMinor: command.amountMinor,
        currency: command.currency,
        paymentMethodToken: command.paymentMethodToken,
        captureMethod: command.captureMethod,
        statementDescriptor: command.statementDescriptor,
        threeDSecure: command.threeDSecure,
        idempotencyKey: `auth:${command.paymentIntentId}:${chargeId}`,
      });
    } catch (err) {
      if (err instanceof CardDeclinedException) {
        await this.recordDecline(charge, command, err);
      }
      throw err;
    }

    if (!result.approved && result.threeDSecure?.authenticationFlow === 'challenge') {
      this.logger.info('authorization_requires_action', {
        charge_id: chargeId,
        merchant_id: command.merchant.id,
        acquirer: adapter.acquirer,
      });
      return { charge, result, requiresAction: true };
    }

    if (!result.approved) {
      const declineCode = result.declineCode ?? 'processing_error';
      const exception = this.declineException(declineCode, 'The issuer declined the authorisation');
      await this.recordDecline(charge, command, exception);
      throw exception;
    }

    await this.persistApproval(charge, command, result);
    return { charge, result, requiresAction: false };
  }

  private async insertPendingCharge(
    chargeId: ChargeId,
    command: AuthorizeChargeCommand,
    acquirer: Acquirer,
    card: AuthorizeResult['card'],
  ): Promise<ChargeEntity> {
    return this.transactions.runInTransaction(async (manager) => {
      const charge = manager.create(ChargeEntity, {
        id: chargeId,
        merchant_id: command.merchant.id,
        payment_intent_id: command.paymentIntentId,
        amount_minor: command.amountMinor,
        captured_amount_minor: 0,
        refunded_amount_minor: 0,
        currency: command.currency,
        status: 'pending',
        card_brand: card.brand,
        card_last_four: card.last_four,
        card_exp_month: card.exp_month,
        card_exp_year: card.exp_year,
        card_country: card.country,
        card_funding: card.funding,
        acquirer,
        capture_method: command.captureMethod,
        risk_score: 0,
        livemode: command.livemode,
        metadata: {},
      });
      return manager.save(ChargeEntity, charge);
    });
  }

  private async persistApproval(
    charge: ChargeEntity,
    command: AuthorizeChargeCommand,
    result: AuthorizeResult,
  ): Promise<void> {
  }
}
