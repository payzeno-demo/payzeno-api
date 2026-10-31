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
 *      `requires_payment_method` / `failed`) is written in its own transaction from the
 *      acquirer's answer.
 *   4. `capture_method: automatic` really captures: the approval lands in `requires_capture`,
 *      ChargeCaptureService issues the capture and emits `payment.captured`, and only then does
 *      the intent move to `succeeded`. Landing on `succeeded` from the authorisation alone left
 *      an authorised charge that nothing would ever capture.
 *
 * A confirm with no payment method while the intent is `requires_action` is the 3-D Secure
 * resume: the cardholder finished the challenge, and the acquirer's answer is read back and
 * landed exactly like a frictionless one.
 *
 * RFC platform-v2 §8: an approval carries the platform rules' verdict. `review` lands in
 * `requires_capture` with an open review and is NOT auto-captured; `block` is voided and lands
 * as a decline (`RiskGate`). The `ConfirmContext` is what internal callers know and a public
 * confirm request cannot say: the shopper as the edge saw them, the saved card behind the
 * token, and whether this is an off-session renewal (no 3-D Secure, no platform rules).
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  ConfirmPaymentIntentRequest,
  Merchant,
  NextAction,
  PaymentMethodId,
  PaymentMethodToken,
  ReviewId,
} from '@payzeno/contracts';

import { ValidationException } from '../../common/errors/api.exception';
import { CardDeclinedException } from '../../common/errors/card.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { assertCallbackUrl } from '../../common/validators/callback-url';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { MerchantsService, toMerchantResponse } from '../../merchants/merchants.service';
import {
  ChargeAuthorizationService,
  type AuthorizationOutcome,
} from '../charge-authorization.service';
import { ChargeCaptureService } from '../charge-capture.service';
import { ChargeEntity } from '../charge.entity';
import { ChargeRepository } from '../charge.repository';
import { PaymentIntentEntity } from '../payment-intent.entity';
import { PaymentIntentRepository } from '../payment-intent.repository';
import type { ShopperContext } from '../shopper-context';
import { PaymentIntentStateMachine, type PaymentIntentEvent } from '../state/payment-intent.state-machine';

import { PaymentFlow } from './payment.flow';
import { RiskGate } from './risk-gate';

export interface ConfirmContext {
  shopper?: ShopperContext;
  /** The saved card the request's token belongs to. Absent for a fresh token. */
  paymentMethodId?: PaymentMethodId | null;
  /** A merchant-initiated renewal: no 3-D Secure, no platform rules. */
  offSession?: boolean;
}

@Injectable()
export class ConfirmPaymentFlow extends PaymentFlow<ConfirmPaymentIntentRequest> {
  constructor(
    intents: PaymentIntentRepository,
    states: PaymentIntentStateMachine,
    transactions: TransactionManager,
    private readonly authorization: ChargeAuthorizationService,
    private readonly capture: ChargeCaptureService,
    private readonly charges: ChargeRepository,
    private readonly merchants: MerchantsService,
    private readonly riskGate: RiskGate,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
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
    context: ConfirmContext = {},
  ): Promise<PaymentIntentEntity> {
    if (request.return_url) {
      assertCallbackUrl(request.return_url, 'return_url', this.config.runtime.nodeEnv);
    }

    if (Number(intent.amount_minor) === 0) {
      // A `setup` checkout session's intent: it exists for its client secret, never to charge.
      throw new ValidationException('This payment intent saves a card and cannot be confirmed', [
        { path: 'amount_minor', code: 'setup_intent', message: 'complete the checkout session instead' },
      ]);
    }

    if (intent.status === 'requires_action' && !request.payment_method_token) {
      return this.resumeAuthentication(intent);
    }

    const token = (request.payment_method_token ?? intent.payment_method_token) as PaymentMethodToken | null;
    if (!token) {
      throw new ValidationException('A payment method is required to confirm this intent', [
        { path: 'payment_method_token', code: 'required', message: 'no payment method on the intent' },
      ]);
    }

    // Step 1 — guard, then park the intent in `processing` before anything leaves the process.
    // The token is written with it, so the intent says which card this attempt used — and, for
    // a new token, that the saved card of an earlier attempt is no longer the one in play.
    const paymentMethodId = request.payment_method_token
      ? (context.paymentMethodId ?? null)
      : intent.payment_method_id;
    const processing = this.nextStatus(intent, 'confirm');
    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.transition(manager, intent, processing, {
        payment_method_token: token,
        payment_method_id: paymentMethodId,
      });
      if (affected === 0) {
        throw new ValidationException('This payment intent is already being confirmed', [
          { path: 'status', code: 'conflict', message: 'concurrent confirm' },
        ]);
      }
    });
    intent.payment_method_token = token;
    intent.payment_method_id = paymentMethodId;

    // getById returns the entity; the services below take the contracts type, and the
    // mapping lives in exactly one place (merchants.service.ts).
    const merchant = toMerchantResponse(await this.merchants.getById(intent.merchantId));

    // Step 2 — the acquirer round trip. Outside any transaction, on purpose.
    let outcome: AuthorizationOutcome;
    try {
      outcome = await this.authorization.authorize({
        merchant,
        paymentIntentId: intent.id,
        amountMinor: Number(intent.amount_minor),
        currency: intent.currency,
        paymentMethodToken: token,
        captureMethod: intent.capture_method,
        statementDescriptor: intent.statement_descriptor,
        // Off-session there is nobody to send through a challenge.
        threeDSecure: request.return_url && !context.offSession
          ? { returnUrl: request.return_url, challengePreference: 'auto' }
          : null,
        livemode: intent.livemode,
        correlationId: intent.id,
        shopper: context.shopper,
        skipRisk: context.offSession === true,
        subscriptionId: intent.subscription_id,
      });
    } catch (err) {
      await this.landOnFailure(intent, err);
      throw err;
    }

    // Step 3 — land it.
    if (outcome.requiresAction) {
      return this.landOnAction(intent, request.return_url ?? null, outcome);
    }
    return this.landOnVerdict(intent, outcome, merchant);
  }

  /** §8: the platform rules' verdict decides how an approval lands. */
  private async landOnVerdict(
    intent: PaymentIntentEntity,
    outcome: AuthorizationOutcome,
    merchant: Merchant,
  ): Promise<PaymentIntentEntity> {
    if (outcome.risk?.outcome === 'block') {
      return this.riskGate.block(intent, outcome.charge, outcome.risk);
    }
    const hold = outcome.risk?.outcome === 'review' && outcome.reviewId
      ? { risk: outcome.risk, reviewId: outcome.reviewId }
      : null;
    return this.landOnApproval(intent, outcome.charge, merchant, hold);
  }

  /**
   * The 3-D Secure resume. The intent moves `requires_action → processing` before the acquirer
   * is asked, for the same reason step 1 parks a fresh confirm: two resumes racing must not both
   * land the authorisation.
   */
  private async resumeAuthentication(intent: PaymentIntentEntity): Promise<PaymentIntentEntity> {
    const charge = intent.latest_charge_id
      ? await this.charges.findOne({ where: { id: intent.latest_charge_id } })
      : null;
    if (!charge) {
      throw new ValidationException('This payment intent has no authorisation waiting on 3-D Secure', [
        { path: 'latest_charge_id', code: 'missing', message: 'confirm with a payment method first' },
      ]);
    }

    const processing = this.nextStatus(intent, 'complete_action');
    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.transition(manager, intent, processing);
      if (affected === 0) {
        throw new ValidationException('This payment intent is already being confirmed', [
          { path: 'status', code: 'conflict', message: 'concurrent confirm' },
        ]);
      }
    });

    const merchant = toMerchantResponse(await this.merchants.getById(intent.merchantId));

    let outcome: AuthorizationOutcome;
    try {
      outcome = await this.authorization.resumeAuthentication(charge, {
        merchant,
        paymentIntentId: intent.id,
        amountMinor: Number(intent.amount_minor),
        currency: intent.currency,
        captureMethod: intent.capture_method,
        livemode: intent.livemode,
        correlationId: intent.id,
        subscriptionId: intent.subscription_id,
      });
    } catch (err) {
      await this.landOnFailure(intent, err);
      throw err;
    }

    if (outcome.requiresAction) {
      // Back without finishing the challenge: same challenge, same next_action.
      const waiting = this.states.apply('processing', 'require_action');
      await this.transactions.runInTransaction(async (manager) => {
        await this.intents.transitionStatus(manager, intent.id, 'processing', waiting);
      });
      intent.status = waiting;
      return intent;
    }

    return this.landOnVerdict(intent, outcome, merchant);
  }

  /**
   * An approval. `manual` parks at `requires_capture` for the merchant; `automatic` parks there
   * too, then captures. A capture that fails after the approval leaves the intent in
   * `requires_capture` with the money authorised — logged loudly, capturable by hand — rather
   * than claiming a `succeeded` that never happened. A §8 hold parks there with its review
   * written in the same commit, and is never auto-captured.
   */
  private async landOnApproval(
    intent: PaymentIntentEntity,
    charge: ChargeEntity,
    merchant: Merchant,
    hold: { risk: NonNullable<AuthorizationOutcome['risk']>; reviewId: ReviewId } | null = null,
  ): Promise<PaymentIntentEntity> {
    const authorized = this.states.apply('processing', 'authorize');

    await this.transactions.runInTransaction(async (manager) => {
      // The review row first: `payment_intent.review_id` references it.
      if (hold) {
        await this.riskGate.openReview(manager, intent, charge, merchant, hold.risk, hold.reviewId);
      }
      await this.intents.transitionStatus(manager, intent.id, 'processing', authorized, {
        latest_charge_id: charge.id,
        next_action: null,
        ...(hold ? { review_id: hold.reviewId } : {}),
      });
    });

    intent.status = authorized;
    intent.latest_charge_id = charge.id;
    intent.next_action = null;
    if (hold) intent.review_id = hold.reviewId;

    if (intent.capture_method === 'automatic' && !hold) {
      await this.captureAutomatically(intent, charge, merchant);
    }

    this.logger.info('payment_intent_confirmed', {
      payment_intent_id: intent.id,
      charge_id: charge.id,
      status: intent.status,
      capture_method: intent.capture_method,
      acquirer: charge.acquirer,
    });

    return intent;
  }

  private async captureAutomatically(
    intent: PaymentIntentEntity,
    charge: ChargeEntity,
    merchant: Merchant,
  ): Promise<void> {
    const succeeded = this.states.apply(intent.status, 'capture');
    try {
      await this.capture.captureCharge({ charge, merchant, correlationId: intent.id });
    } catch (err) {
      // captureCharge commits the capture and `payment.captured` before its synchronous ledger
      // posting, so a throw does not by itself mean nothing was captured. The intent follows
      // the charge row, not the exception.
      const reread = await this.charges.findOne({ where: { id: charge.id } });
      if (reread?.status !== 'captured') {
        this.logger.error('payment_intent_auto_capture_failed', err, {
          payment_intent_id: intent.id,
          charge_id: charge.id,
        });
        return;
      }
      this.logger.warn('payment_intent_auto_capture_post_step_failed', {
        payment_intent_id: intent.id,
        charge_id: charge.id,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    await this.transactions.runInTransaction(async (manager) => {
      await this.intents.transitionStatus(manager, intent.id, intent.status, succeeded);
    });
    intent.status = succeeded;
  }

  /**
   * The SCA branch. `next_action.url` is the acquirer's own challenge page when it hosts one;
   * otherwise the hosted checkout's challenge route. Either way the cardholder comes back to
   * `return_url` and the client confirms again without a payment method to resume.
   */
  private async landOnAction(
    intent: PaymentIntentEntity,
    returnUrl: string | null,
    outcome: AuthorizationOutcome,
  ): Promise<PaymentIntentEntity> {
    const chargeId = outcome.charge.id;
    const nextAction: NextAction = {
      type: 'redirect_to_url',
      url:
        outcome.result.challengeUrl ??
        `${this.config.checkout.publicUrl}/3ds/${encodeURIComponent(chargeId)}`,
      sdk_payload: returnUrl ? { return_url: returnUrl } : undefined,
    };

    const status = this.states.apply('processing', 'require_action');

    await this.transactions.runInTransaction(async (manager) => {
      await this.intents.transitionStatus(manager, intent.id, 'processing', status, {
        latest_charge_id: chargeId,
        next_action: nextAction,
      });
    });

    intent.status = status;
    intent.next_action = nextAction;
    intent.latest_charge_id = chargeId;

    this.logger.info('payment_intent_requires_action', {
      payment_intent_id: intent.id,
      charge_id: chargeId,
      has_return_url: Boolean(returnUrl),
      acquirer_challenge: outcome.result.challengeUrl !== null,
    });

    return intent;
  }

  /**
   * A card decline sends the buyer back for another payment method (`requires_payment_method`),
   * whatever the code — the next card is a different card. Anything else (the acquirer or the
   * vault failing to answer) terminates the intent. The distinction is the FSM's, not this
   * file's — see the `decline` vs `fail` edges out of `processing`.
   */
  private async landOnFailure(intent: PaymentIntentEntity, err: unknown): Promise<void> {
    const declined = err instanceof CardDeclinedException;
    const event: PaymentIntentEvent = declined ? 'decline' : 'fail';
    const status = this.states.apply('processing', event);

    let latestChargeId = intent.latest_charge_id;
    await this.transactions.runInTransaction(async (manager) => {
      // The attempt that just failed is the intent's latest charge: its decline code is what the
      // buyer is shown (checkout's `payment.last_error`), and without this a declined intent
      // pointed at no charge at all. None exists when the vault failed before the insert.
      const [attempt] = await this.charges.listForIntent(intent.id, manager);
      latestChargeId = attempt?.id ?? latestChargeId;
      await this.intents.transitionStatus(manager, intent.id, 'processing', status, {
        next_action: null,
        latest_charge_id: latestChargeId,
      });
    });

    intent.status = status;
    intent.next_action = null;
    intent.latest_charge_id = latestChargeId;

    this.logger.warn('payment_intent_confirm_failed', {
      payment_intent_id: intent.id,
      landed_in: status,
      declined,
      decline_code: declined ? err.declineCode : null,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}
