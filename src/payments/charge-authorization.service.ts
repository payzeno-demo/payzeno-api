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
 *
 * RFC platform-v2 §8: Payzeno's risk rules run between the issuer's approval and that write,
 * so the approval is recorded with its risk outcome and `payment.authorized` carries the
 * review id when the payment is held. Acting on the outcome — hold or void — is the confirm
 * flow's. Off-session renewals skip the rules (`skipRisk`): a merchant-initiated charge on a
 * card the shopper already paid with has no shopper in front of it to judge.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  Acquirer,
  ChargeId,
  DeclineCode,
  Merchant,
  PaymentMethodToken,
  ReviewId,
  SubscriptionId,
} from '@payzeno/contracts';

import { ConflictException } from '../common/errors/api.exception';
import { CardDeclinedException, ExpiredCardException, InsufficientFundsException } from '../common/errors/card.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { REVIEW_ID_PREFIX } from '../risk/review.entity';
import { RiskEngine, type RiskAssessment } from '../risk/risk-engine.service';

import { ChargeExpiryPolicy } from './charge-expiry.policy';
import { ChargeEntity } from './charge.entity';
import { ChargeRepository } from './charge.repository';
import { ProcessorRouter } from './processor/processor.router';
import { isRetryableDecline, type AuthorizeResult, type ThreeDSecureRequest } from './processor/processor.types';
import type { ShopperContext } from './shopper-context';
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
  /** §8: who is paying, as the edge saw them. Stored on the charge for the velocity rules. */
  shopper?: ShopperContext;
  /** §8: off-session renewals are not judged by the platform rules. */
  skipRisk?: boolean;
  /** §6: carried onto `payment.failed` so a merchant can tell a failed renewal. */
  subscriptionId?: SubscriptionId | null;
}

/** What resuming a 3-D Secure authorisation needs: the original command, minus the card. */
export type ResumeAuthorizationCommand = Omit<
  AuthorizeChargeCommand,
  'paymentMethodToken' | 'statementDescriptor' | 'threeDSecure' | 'shopper'
>;

export interface AuthorizationOutcome {
  charge: ChargeEntity;
  result: AuthorizeResult;
  /** True when the issuer demanded SCA; the intent moves to `requires_action`. */
  requiresAction: boolean;
  /** §8: the platform rules' verdict on an approval. Null while pending SCA or when skipped. */
  risk: RiskAssessment | null;
  /** §8: minted when `risk.outcome === 'review'`; already on `payment.authorized`. */
  reviewId: ReviewId | null;
}

@Injectable()
export class ChargeAuthorizationService {
  constructor(
    private readonly charges: ChargeRepository,
    private readonly router: ProcessorRouter,
    private readonly vault: VaultClient,
    private readonly expiry: ChargeExpiryPolicy,
    private readonly risk: RiskEngine,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async authorize(command: AuthorizeChargeCommand): Promise<AuthorizationOutcome> {
    const adapter = this.router.select(command.merchant, command.currency, { livemode: command.livemode });
    const chargeId = this.ids.chargeId() as ChargeId;

    // The vault is the only place card details exist. We get a CardSummary and a fingerprint;
    // the digits never enter this process (arc PCI, docs/adr/0014-client-side-tokenisation.md).
    const resolution = await this.vault.resolve(command.paymentMethodToken);

    const charge = await this.insertPendingCharge(chargeId, command, adapter.acquirer, resolution.card, resolution.fingerprint);

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

    if (result.pendingAuthentication) {
      // Keep the acquirer's reference on the pending charge: it is how the resumed confirm
      // reads the challenge outcome back (`resumeAuthentication`).
      await this.transactions.runInTransaction((manager) =>
        this.charges.markAwaitingAuthentication(manager, charge.id, result.processorReference),
      );
      charge.processor_reference = result.processorReference;
      this.logger.info('authorization_requires_action', {
        charge_id: chargeId,
        merchant_id: command.merchant.id,
        acquirer: adapter.acquirer,
        has_challenge_url: result.challengeUrl !== null,
      });
      return { charge, result, requiresAction: true, risk: null, reviewId: null };
    }

    if (!result.approved) {
      const declineCode = result.declineCode ?? 'processing_error';
      const exception = this.declineException(declineCode, 'The issuer declined the authorisation');
      await this.recordDecline(charge, command, exception);
      throw exception;
    }

    return this.approve(charge, command, result);
  }

  /**
   * The second half of a 3-D Secure authorisation. The cardholder finished the challenge on the
   * acquirer's page; read the outcome back from the acquirer that issued it and land it the way
   * `authorize` lands a frictionless answer — approval persisted and `payment.authorized` on the
   * outbox, or the decline recorded and thrown.
   */
  async resumeAuthentication(
    charge: ChargeEntity,
    command: ResumeAuthorizationCommand,
  ): Promise<AuthorizationOutcome> {
    if (charge.status !== 'pending' || !charge.processor_reference) {
      throw new ConflictException('This charge is not waiting on 3-D Secure', {
        charge_id: charge.id,
        status: charge.status,
      });
    }

    const adapter = this.router.forAcquirer(charge.acquirer, { livemode: command.livemode });
    const result = await adapter.getAuthorization(charge.processor_reference);

    if (result.pendingAuthentication) {
      // The cardholder came back without finishing the challenge. Nothing to land yet.
      return { charge, result, requiresAction: true, risk: null, reviewId: null };
    }

    if (!result.approved) {
      const exception = this.declineException(
        result.declineCode ?? 'processing_error',
        'The issuer declined the authorisation after 3-D Secure',
      );
      await this.recordDecline(charge, command, exception);
      throw exception;
    }

    return this.approve(charge, command, result);
  }

  /**
   * The issuer said yes. Run the platform rules on the approval (the acquirer's score is known
   * now), mint the review id when they hold it, and persist the approval with both.
   */
  private async approve(
    charge: ChargeEntity,
    command: ResumeAuthorizationCommand,
    result: AuthorizeResult,
  ): Promise<AuthorizationOutcome> {
    charge.risk_score = result.riskScore;
    const risk = command.skipRisk ? null : await this.risk.assess(charge, command.merchant);
    const reviewId = risk?.outcome === 'review' ? (this.ids.opaque(REVIEW_ID_PREFIX) as ReviewId) : null;

    await this.persistApproval(charge, command, result, risk, reviewId);
    return { charge, result, requiresAction: false, risk, reviewId };
  }

  private async insertPendingCharge(
    chargeId: ChargeId,
    command: AuthorizeChargeCommand,
    acquirer: Acquirer,
    card: AuthorizeResult['card'],
    fingerprint: string,
  ): Promise<ChargeEntity> {
    return this.transactions.runInTransaction(async (manager) => {
      const charge = manager.create(ChargeEntity, {
        id: chargeId,
        merchantId: command.merchant.id,
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
        card_fingerprint: fingerprint,
        shopper_ip: command.shopper?.ip ?? null,
        shopper_country: command.shopper?.country ?? null,
        risk_outcome: null,
        livemode: command.livemode,
        metadata: {},
      });
      return manager.save(ChargeEntity, charge);
    });
  }

  private async persistApproval(
    charge: ChargeEntity,
    command: ResumeAuthorizationCommand,
    result: AuthorizeResult,
    risk: RiskAssessment | null,
    reviewId: ReviewId | null,
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
        riskOutcome: risk?.outcome ?? null,
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
          // Present only when held: the ledger validates this payload with extra='forbid', and
          // an image built before the field existed must keep accepting every other payment.
          ...(reviewId ? { review_id: reviewId } : {}),
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

    // The row now says `authorized`; so does the entity the caller holds. An automatic-capture
    // confirm hands this straight to ChargeCaptureService, which checks exactly these fields.
    charge.status = 'authorized';
    charge.network_transaction_id = result.networkTransactionId;
    charge.authorization_code = result.authorizationCode;
    charge.processor_reference = result.processorReference;
    charge.authorized_at = authorizedAt;
    charge.authorization_expires_at = expiresAt;
    charge.risk_score = result.riskScore;
    charge.risk_outcome = risk?.outcome ?? null;
  }

  private async recordDecline(
    charge: ChargeEntity,
    command: ResumeAuthorizationCommand,
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
          ...(command.subscriptionId ? { subscription_id: command.subscriptionId } : {}),
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

  private declineException(code: DeclineCode, message: string): CardDeclinedException {
    if (code === 'insufficient_funds') {
      return new InsufficientFundsException();
    }
    if (code === 'expired_card') {
      return new ExpiredCardException();
    }
    return new CardDeclinedException(code, message);
  }
}
