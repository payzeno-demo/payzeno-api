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
    private readonly router: ProcessorRouter,
    private readonly vault: VaultClient,
    private readonly expiry: ChargeExpiryPolicy,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async authorize(command: AuthorizeChargeCommand): Promise<AuthorizationOutcome> {
    const adapter = this.router.select(command.merchant, command.currency, { livemode: command.livemode });
    const chargeId = this.ids.generate(API_ID_PREFIXES.charge) as ChargeId;

    // The vault is the only place card details exist. We get a CardSummary and a fingerprint;
    // the digits never enter this process (arc PCI, docs/adr/0014-client-side-tokenisation.md).
    const resolution = await this.vault.resolve(command.paymentMethodToken);

    const charge = await this.insertPendingCharge(chargeId, command, adapter.acquirer, resolution.card);

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
    const authorizedAt = this.clock.now();
    const expiresAt = this.expiry.expiresAt(command.merchant.mcc, authorizedAt);

    await this.transactions.runInTransaction(async (manager) => {
      await this.charges.markAuthorized(manager, charge.id, {
        networkTransactionId: result.networkTransactionId,
        authorizationCode: result.authorizationCode,
        processorReference: result.processorReference,
        authorizedAt,
        authorizationExpiresAt: expiresAt,
        riskScore: result.riskScore,
      });

      // Consumed by payzeno-ledger's PaymentEventConsumer, which builds `settlement_charge`.
      // reserve_bps and processor_reference are required there (events.ts §PaymentAuthorized) —
      // without them the reserve leg of every settle posting is unreachable.
      await this.events.publish(
        'payment.authorized',
        {
          charge_id: charge.id,
          payment_intent_id: command.paymentIntentId,
          merchant_id: command.merchant.id,
          amount_minor: command.amountMinor,
          currency: command.currency,
          capture_method: command.captureMethod,
          capture_at_settlement: command.merchant.capture_at_settlement,
          card_brand: result.card.brand,
          card_last_four: result.card.last_four,
          authorization_code: result.authorizationCode ?? '',
          network_transaction_id: result.networkTransactionId ?? '',
          reserve_bps: command.merchant.reserve_bps,
          processor_reference: result.processorReference,
          acquirer: charge.acquirer,
          risk_score: result.riskScore,
          authorized_at: authorizedAt.toISOString(),
        },
        {
          merchantId: command.merchant.id,
          correlationId: command.correlationId,
          causationId: null,
          livemode: command.livemode,
          occurredAt: authorizedAt.toISOString(),
        },
      );
    });
  }

  private async recordDecline(
    charge: ChargeEntity,
    command: AuthorizeChargeCommand,
    exception: CardDeclinedException,
  ): Promise<void> {
    const failedAt = this.clock.now();
    await this.transactions.runInTransaction(async (manager) => {
      await this.charges.markDeclined(manager, charge.id, exception.declineCode, exception.message);
      await this.events.publish(
        'payment.failed',
        {
          charge_id: charge.id,
          payment_intent_id: command.paymentIntentId,
          merchant_id: command.merchant.id,
          amount_minor: command.amountMinor,
          currency: command.currency,
          failure_code: exception.declineCode,
          failure_message: exception.message,
          retryable: isRetryableDecline(exception.declineCode),
          failed_at: failedAt.toISOString(),
        },
        {
          merchantId: command.merchant.id,
          correlationId: command.correlationId,
          causationId: null,
          livemode: command.livemode,
          occurredAt: failedAt.toISOString(),
        },
      );
    });
  }

  private declineException(code: string, message: string): CardDeclinedException {
    if (code === 'insufficient_funds') {
      return new InsufficientFundsException(message, code);
    }
    if (code === 'expired_card') {
      return new ExpiredCardException(message, code);
    }
    return new CardDeclinedException(message, code);
  }
}
