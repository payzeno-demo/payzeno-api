/**
 * CancelPaymentFlow — the void path.
 *
 * `POST /v1/payment_intents/:id/cancel` is how an authorisation is released. It is NOT a
 * refund and it deliberately creates no `refund` row: a void reverses the hold at the network,
 * recovers interchange, and produces no cardholder-visible credit line. `POST /v1/refunds`
 * against an uncaptured charge is rejected precisely so the two cannot be confused
 * (domain-model §4).
 *
 * Two side effects, in this order:
 *   1. the acquirer void (skipped when there is no live hold — a `requires_confirmation`
 *      intent has never spoken to an acquirer);
 *   2. the ledger's `auth_release` posting, which is what unwinds `authorization_hold`.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CancelPaymentIntentRequest, CancellationReason, ChargeId } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../../events/publisher';
import { LedgerReadThroughService } from '../../ledger/ledger-read-through.service';
import { ledgerKey } from '../../ledger/ledger.types';
import { ChargeRepository } from '../charge.repository';
import { ChargeStateMachine } from '../state/charge.state-machine';
import { PaymentIntentEntity } from '../payment-intent.entity';
import { PaymentIntentRepository } from '../payment-intent.repository';
import { ProcessorRouter } from '../processor/processor.router';
import { PaymentIntentStateMachine, type PaymentIntentEvent } from '../state/payment-intent.state-machine';
import { PaymentFlow } from './payment.flow';

@Injectable()
export class CancelPaymentFlow extends PaymentFlow<CancelPaymentIntentRequest> {
  constructor(
    intents: PaymentIntentRepository,
    states: PaymentIntentStateMachine,
    transactions: TransactionManager,
    private readonly charges: ChargeRepository,
    private readonly chargeStates: ChargeStateMachine,
    private readonly router: ProcessorRouter,
    private readonly ledger: LedgerReadThroughService,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(intents, states, transactions, logger);
  }

  get flowName(): string {
    return 'payment_intent.cancel';
  }

  protected get entryEvent(): PaymentIntentEvent {
    return 'cancel';
  }

  async execute(
    intent: PaymentIntentEntity,
    request: CancelPaymentIntentRequest,
  ): Promise<PaymentIntentEntity> {
    const canceled = this.nextStatus(intent, 'cancel');
    const reason: CancellationReason = request.cancellation_reason ?? 'requested_by_customer';
    const canceledAt = this.clock.now();

    const charge = intent.latest_charge_id
      ? await this.charges.findOne({ where: { id: intent.latest_charge_id as ChargeId } })
      : null;

    let releasedMinor = 0;

    if (charge && this.chargeStates.holdsAuthorization(charge.status)) {
      const adapter = this.router.forAcquirer(charge.acquirer, { livemode: charge.livemode });

      const result = await adapter.void({
        networkTransactionId: charge.network_transaction_id ?? '',
        idempotencyKey: ledgerKey('auth_release', charge.id),
      });

      if (result.voided) {
        await this.transactions.runInTransaction(async (manager) => {
          await this.charges.markVoided(manager, charge.id);
        });
        releasedMinor = Number(charge.amount_minor);
      } else {
        // The acquirer refused the void — usually because the hold already expired at their
        // end. The intent still cancels; the hold falls off on its own within 7 days.
        this.logger.warn('acquirer_void_refused', {
          payment_intent_id: intent.id,
          charge_id: charge.id,
          acquirer: charge.acquirer,
        });
      }
    }

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.transition(manager, intent, canceled, {
        canceled_at: canceledAt,
        cancellation_reason: reason,
        next_action: null,
      });
      if (affected === 0) {
        // Already cancelled. Cancel is idempotent by design: the console retries it on a
        // dropped connection and a 409 there is noise, not information.
        this.logger.debug('payment_intent_already_canceled', { payment_intent_id: intent.id });
        return;
      }

      await this.events.publish(
        'payment.canceled',
        {
          payment_intent_id: intent.id,
          charge_id: charge ? charge.id : null,
          merchant_id: intent.merchantId,
          released_amount_minor: releasedMinor,
          currency: intent.currency,
          cancellation_reason: reason,
          canceled_at: canceledAt.toISOString(),
        },
        {
          merchantId: intent.merchantId,
          correlationId: intent.id,
          causationId: null,
          livemode: intent.livemode,
          occurredAt: canceledAt.toISOString(),
        },
      );
    });

    if (releasedMinor > 0 && charge) {
      // Unwinds `authorization_hold`. Deterministic key, so the event-driven posting the
      // ledger's PaymentEventConsumer makes from `payment.canceled` is a no-op on arrival.
      await this.ledger.releaseAuthorization({
        chargeId: charge.id,
        merchantId: intent.merchantId,
        currency: intent.currency,
        livemode: intent.livemode,
        amountMinor: releasedMinor,
      });
    }

    intent.canceled_at = canceledAt;
    intent.cancellation_reason = reason;

    this.logger.info('payment_intent_canceled', {
      payment_intent_id: intent.id,
      charge_id: charge?.id ?? null,
      released_amount_minor: releasedMinor,
      cancellation_reason: reason,
    });

    return intent;
  }
}
