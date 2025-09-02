/**
 * RefundPolicyService — L5, the two rules that decide whether a refund may exist at all.
 *
 *   1. **Window.** Card schemes cap refunds at roughly 180 days from the original
 *      transaction. Past `REFUND_WINDOW_DAYS` the merchant pays the cardholder out of band.
 *   2. **Amount.** `sum(refunds) + requested <= charge.captured_amount_minor`, evaluated
 *      while holding `SELECT … FOR UPDATE` on the charge row.
 *
 * Rule 2's lock is not decoration. Two concurrent full refunds against the same charge each
 * read `refunded_amount_minor = 0`, each pass the check, and the merchant refunds twice. The
 * lock is taken on the CHARGE, not on the refund, because the charge is the row both writers
 * contend on — and it is taken before any read of the refund table, so the ordering matches
 * ADR 0011's rule about not holding a row lock while waiting for another.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ChargeId, MinorUnits, RefundReason } from '@payzeno/contracts';

import {
  RefundAmountExceededException,
  RefundWindowClosedException,
} from '../common/errors/business.exceptions';
import { ChargeNotFoundException } from '../common/errors/not-found.exceptions';
import { InvalidStateTransitionException } from '../common/errors/state.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { ChargeEntity } from '../payments/charge.entity';
import { ChargeRepository } from '../payments/charge.repository';
import { ChargeStateMachine } from '../payments/state/charge.state-machine';
import { RefundRepository } from './refund.repository';

/** domain-model.md §4. 180 days is the tightest of the four schemes we route to. */
export const REFUND_WINDOW_DAYS = 180;

export interface RefundPolicyDecision {
  charge: ChargeEntity;
  amountMinor: MinorUnits;
  reason: RefundReason;
  /** True while the charge is `captured` — the credit nets into the open acquirer batch. */
  netsAgainstSettlement: boolean;
}

@Injectable()
export class RefundPolicyService {
  constructor(
    private readonly charges: ChargeRepository,
    private readonly refunds: RefundRepository,
    private readonly chargeStates: ChargeStateMachine,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Runs inside the caller's transaction and returns the decision the caller writes.
   * Every throw here is a 4xx the merchant can act on.
   */
  async evaluate(
    manager: EntityManager,
    chargeId: ChargeId,
    requestedMinor: MinorUnits | undefined,
    reason: RefundReason | undefined,
  ): Promise<RefundPolicyDecision> {
    const charge = await this.charges.lockForUpdate(chargeId, manager);
    if (!charge) {
      throw new ChargeNotFoundException(chargeId);
    }

    this.assertRefundableStatus(charge);
    this.assertWithinWindow(charge);

    const alreadyRefunded = await this.refunds.sumRefundedForCharge(manager, chargeId);
    const refundable = Number(charge.captured_amount_minor) - alreadyRefunded;
    const amountMinor = requestedMinor ?? refundable;

    if (amountMinor <= 0 || amountMinor > refundable) {
      throw new RefundAmountExceededException(chargeId, amountMinor, Math.max(0, refundable), charge.currency);
    }

    this.logger.debug('refund_policy_passed', {
      charge_id: chargeId,
      requested_minor: amountMinor,
      already_refunded_minor: alreadyRefunded,
      refundable_minor: refundable,
      charge_status: charge.status,
    });

    return {
      charge,
      amountMinor,
      reason: reason ?? 'requested_by_customer',
      netsAgainstSettlement: charge.status === 'captured',
    };
  }

  /**
   * An `authorized` charge takes a void, not a refund — different network call, different
   * interchange treatment, no cardholder-visible credit. `POST /v1/refunds` against one is
   * rejected here rather than silently turned into a cancel (domain-model §4).
   */
  private assertRefundableStatus(charge: ChargeEntity): void {
    if (this.chargeStates.isRefundable(charge.status)) {
      return;
    }
    throw new InvalidStateTransitionException(
      'charge',
      charge.status,
      'refund',
      charge.status === 'authorized'
        ? `Charge ${charge.id} is authorised but not captured — cancel the payment intent to release the hold`
        : `Charge ${charge.id} is '${charge.status}' and cannot be refunded`,
    );
  }

  private assertWithinWindow(charge: ChargeEntity): void {
    const anchor = charge.captured_at ?? charge.authorized_at;
    if (!anchor) {
      // No capture timestamp on a captured charge means the row predates migration 07. Six
      // rows, all from month 1, all long past the window; treat them as closed.
      throw new RefundWindowClosedException(charge.id, REFUND_WINDOW_DAYS);
    }

    const ageDays = (this.clock.nowMs() - anchor.getTime()) / 86_400_000;
    if (ageDays > REFUND_WINDOW_DAYS) {
      throw new RefundWindowClosedException(charge.id, REFUND_WINDOW_DAYS);
    }
  }

  /** Console affordance: how much may still be refunded, without taking a lock. */
  async refundableAmount(chargeId: ChargeId, manager: EntityManager): Promise<MinorUnits> {
    const charge = await manager.findOneBy(ChargeEntity, { id: chargeId });
    if (!charge) return 0;
    const refunded = await this.refunds.sumRefundedForCharge(manager, chargeId);
    return Math.max(0, Number(charge.captured_amount_minor) - refunded);
  }
}
