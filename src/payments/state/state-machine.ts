/**
 * The FSM base. Six concretes: `PaymentIntentStateMachine`, `ChargeStateMachine`,
 * `RefundStateMachine`, `DisputeStateMachine`, `WebhookDeliveryStateMachine`,
 * `MerchantStatusStateMachine`.
 *
 * L5 — pure, no I/O, no injection. A state machine that reads a repository is a service
 * wearing a table, and it cannot be table-tested. `src/payments/state/state-machine.spec.ts`
 * drives all six through one `describe.each`.
 *
 * `apply` is the single throw site for `InvalidStateTransitionException` in the whole repo
 * (blueprint §5). Nothing else decides whether a transition is legal.
 */

import { InvalidStateTransitionException } from '../../common/errors/state.exceptions';

export type TransitionTable<TState extends string, TEvent extends string> = Readonly<
  Record<TState, Partial<Record<TEvent, TState>>>
>;

export abstract class StateMachine<TState extends string, TEvent extends string> {
  /** Entity name used in the exception message and in the audit log. */
  abstract readonly entity: string;
  protected abstract readonly transitions: TransitionTable<TState, TEvent>;
  abstract readonly terminalStates: ReadonlySet<TState>;

  can(from: TState, event: TEvent): boolean {
    return this.transitions[from]?.[event] !== undefined;
  }

  /**
   * Returns the state the entity moves to. Throws `InvalidStateTransitionException` (409
   * `invalid_state`) when the transition is not in the table — including when `from` is
   * terminal, because terminal rows are empty.
   */
  apply(from: TState, event: TEvent): TState {
    const next = this.transitions[from]?.[event];
    if (next === undefined) {
      throw new InvalidStateTransitionException(this.entity, from, event, this.allowedEvents(from));
    }
    return next;
  }

  assertNotTerminal(state: TState): void {
    if (this.terminalStates.has(state)) {
      throw new InvalidStateTransitionException(this.entity, state, 'mutate', []);
    }
  }

  /** Events legal from `state`. Used in the 409 body so the console can explain itself. */
  allowedEvents(state: TState): TEvent[] {
    return Object.keys(this.transitions[state] ?? {}) as TEvent[];
  }

  /** Every state the table mentions, source or target. Drives the exhaustiveness spec. */
  states(): TState[] {
    return Object.keys(this.transitions) as TState[];
  }

  /**
   * True when `to` is reachable from `from` by any sequence of events. Used by
   * `LedgerEventsConsumer` to decide whether a late, out-of-order bus event describes a state
   * the entity has already moved past — the bus is explicitly unordered (events.ts header).
   */
  reachable(from: TState, to: TState): boolean {
    const seen = new Set<TState>([from]);
    const queue: TState[] = [from];
    while (queue.length > 0) {
      const current = queue.shift() as TState;
      if (current === to) {
        return true;
      }
      for (const next of Object.values(this.transitions[current] ?? {}) as TState[]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }
}
