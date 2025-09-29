/**
 * PaymentFlow — L6. The multi-aggregate transaction boundary for the payment lifecycle.
 *
 * This layer exists for one reason: `PaymentIntentsService` would otherwise be nine hundred
 * lines. A confirm touches the intent, a charge, the vault, an acquirer, the ledger and the
 * outbox; a capture touches four of those; a cancel touches three. Each of those is a
 * transaction with its own failure semantics, and mixing them into one service produced a file
 * nobody could review — see the PR thread on docs/adr/0001-nestjs-module-boundaries.md.
 *
 * Contract for subclasses:
 *   - `execute()` is the only public method;
 *   - the FSM transition happens BEFORE the side effect, so an illegal transition costs
 *     nothing external;
 *   - the intent write and the event publish share one transaction (ADR 0011);
 *   - a subclass never talks to an acquirer directly — that is L4/L3's job.
 *
 * Concretes: ConfirmPaymentFlow, CapturePaymentFlow, CancelPaymentFlow.
 */

import type { EntityManager } from 'typeorm';
import type { Merchant, PaymentIntentStatus } from '@payzeno/contracts';

import type { PayzenoLogger } from '../../common/logging/logger';
import type { TransactionManager } from '../../common/persistence/transaction.manager';
import type { PaymentIntentEntity } from '../payment-intent.entity';
import type { PaymentIntentRepository } from '../payment-intent.repository';
import type { PaymentIntentEvent, PaymentIntentStateMachine } from '../state/payment-intent.state-machine';

export interface FlowContext {
  merchant: Merchant;
  correlationId: string;
}

export abstract class PaymentFlow<TRequest> {
  protected constructor(
    protected readonly intents: PaymentIntentRepository,
    protected readonly states: PaymentIntentStateMachine,
    protected readonly transactions: TransactionManager,
    protected readonly logger: PayzenoLogger,
  ) {}

  /** Dotted name used in logs and in `audit_log.action`. */
  abstract get flowName(): string;

  /** The FSM event this flow starts with. Checked before anything leaves the process. */
  protected abstract get entryEvent(): PaymentIntentEvent;

  abstract execute(intent: PaymentIntentEntity, request: TRequest): Promise<PaymentIntentEntity>;

  /**
   * Guard + transition in one call. Throws InvalidStateTransitionException from
   * `StateMachine.apply` — the single throw site all six machines reach.
   */
  protected nextStatus(intent: PaymentIntentEntity, event: PaymentIntentEvent): PaymentIntentStatus {
    this.states.assertNotTerminal(intent.status);
    return this.states.apply(intent.status, event);
  }

  /**
   * Writes the transition with the expected status in the WHERE clause. `affected === 0` means
   * a concurrent request won the race; the caller decides whether that is an error (capture)
   * or a no-op (cancel of an already-cancelled intent).
   */
  protected async transition(
    manager: EntityManager,
    intent: PaymentIntentEntity,
    to: PaymentIntentStatus,
    patch: Parameters<PaymentIntentRepository['transitionStatus']>[4] = {},
  ): Promise<number> {
    const affected = await this.intents.transitionStatus(manager, intent.id, intent.status, to, patch);

    this.logger.debug('payment_intent_transition', {
      flow: this.flowName,
      payment_intent_id: intent.id,
      from: intent.status,
      to,
      affected,
    });

    if (affected > 0) {
      intent.status = to;
    }
    return affected;
  }

  /** Entry guard every subclass calls first, so the refusal reads the same in all three. */
  protected assertEntryAllowed(intent: PaymentIntentEntity): void {
    this.nextStatus(intent, this.entryEvent);
  }
}
