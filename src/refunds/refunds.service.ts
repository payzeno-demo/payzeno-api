/**
 * RefundsService — L7. api-surface.md §6.
 *
 * The order of operations matters and it is not the obvious one:
 *
 *   1. open a transaction
 *   2. lock the charge, evaluate the policy, write the `refund` row as `pending`,
 *      bump `charge.refunded_amount_minor`, enqueue `refund.created` on the outbox
 *   3. COMMIT
 *   4. only then call the acquirer, and settle the row from its answer
 *
 * Calling the acquirer inside the transaction would hold the charge's row lock across a
 * network call to a system that took 22 minutes to answer once (PAY-2041), and every other
 * refund on that charge would queue behind it.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  ChargeId,
  ListQuery,
  Paginated,
  Refund,
  RefundId,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { BaseService } from '../common/base/base.service';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import { ledgerKey } from '../ledger/ledger.types';
import { ChargeRepository } from '../payments/charge.repository';
import { ProcessorRouter } from '../payments/processor/processor.router';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundEntity } from './refund.entity';
import { RefundRepository } from './refund.repository';
import { RefundPolicyService } from './refund-policy.service';
import { RefundStateMachine } from './state/refund.state-machine';

@Injectable()
export class RefundsService extends BaseService<RefundEntity> {
  constructor(
    private readonly refunds: RefundRepository,
    private readonly charges: ChargeRepository,
    private readonly policy: RefundPolicyService,
    private readonly states: RefundStateMachine,
    private readonly router: ProcessorRouter,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    const scope = scopeFrom(principal);

    const { refund, netsAgainstSettlement } = await this.transactions.runInTransaction(async (manager) => {
      const decision = await this.policy.evaluate(manager, dto.charge_id, dto.amount_minor, dto.reason);

      const row = await this.refunds.insertRefund(manager, {
        id: this.ids.refundId() as RefundId,
        merchantId: scope.merchantId,
        chargeId: decision.charge.id,
        amountMinor: decision.amountMinor,
        currency: decision.charge.currency,
        reason: decision.reason,
        metadata: dto.metadata ?? {},
        livemode: scope.livemode,
        createdAt: this.clock.now(),
      });

      // Kept on the charge so the next policy evaluation sees it even before the acquirer
      // answers — the sum query and this counter must not disagree.
      await this.charges.addRefundedAmount(manager, decision.charge.id, decision.amountMinor);

      await this.events.publish(
        'refund.created',
        {
          refund_id: row.id,
          charge_id: decision.charge.id,
          merchant_id: scope.merchantId,
          amount_minor: decision.amountMinor,
          currency: decision.charge.currency,
          reason: decision.reason,
          nets_against_settlement: decision.netsAgainstSettlement,
          created_at: row.createdAt.toISOString(),
        },
        {
          merchantId: scope.merchantId,
          correlationId,
          causationId: null,
          livemode: scope.livemode,
          occurredAt: row.createdAt.toISOString(),
        },
      );

      return { refund: row, netsAgainstSettlement: decision.netsAgainstSettlement, charge: decision.charge };
    });

    return this.submitToAcquirer(refund, netsAgainstSettlement, scope);
  }

  /**
   * Step 4. Outside the transaction on purpose — see the header. A failure here leaves the
   * refund `pending`, which is the honest state: we asked and do not yet know.
   *
   * TODO(PAY-1974): pending refunds whose acquirer call threw are only retried by hand.
   * They want a sweep job like UnsettledChargeSweepJob.
   */
  private async submitToAcquirer(
    refund: RefundEntity,
    netsAgainstSettlement: boolean,
    scope: MerchantScope,
  ): Promise<Refund> {
    const charge = await this.charges.findScoped(refund.charge_id, scope);
    if (!charge) {
      throw new ResourceNotFoundException('charge', refund.charge_id);
    }

    const adapter = this.router.forAcquirer(charge.acquirer, { livemode: scope.livemode });

    try {
      const result = await adapter.refund({
        networkTransactionId: charge.network_transaction_id ?? '',
        amountMinor: Number(refund.amount_minor),
        currency: refund.currency,
        reason: refund.reason,
        idempotencyKey: ledgerKey('refund', refund.charge_id, refund.id),
      });

      if (!result.refunded) {
        return this.settleFailure(refund, result.failureReason ?? 'acquirer declined the refund', scope);
      }

      const succeededAt = this.clock.now();
      await this.transactions.runInTransaction(async (manager) => {
        this.states.apply(refund.status, 'succeed');
        await this.refunds.markSucceeded(manager, refund.id, result.processorReference, succeededAt);
      });

      // The ledger posts the refund; a `captured` charge nets it into the open batch, a
      // `settled` one debits the next payout. Deterministic key, so a retry is a no-op there.
      await this.ledger.recordRefund({
        refundId: refund.id,
        chargeId: refund.charge_id,
        merchantId: scope.merchantId,
        currency: refund.currency,
        livemode: scope.livemode,
        amountMinor: Number(refund.amount_minor),
      });

      this.logger.info('refund_succeeded', {
        refund_id: refund.id,
        charge_id: refund.charge_id,
        amount_minor: Number(refund.amount_minor),
        nets_against_settlement: netsAgainstSettlement,
      });

      refund.status = 'succeeded';
      refund.processor_reference = result.processorReference;
      refund.succeeded_at = succeededAt;
      return toRefund(refund);
    } catch (err) {
      // TODO(PAY-2011): this swallows the acquirer's exception class. The console shows
      // `failure_reason` and support asks for the acquirer code every single time.
      const message = err instanceof Error ? err.message : 'acquirer call failed';
      return this.settleFailure(refund, message, scope);
    }
  }

  private async settleFailure(refund: RefundEntity, reason: string, scope: MerchantScope): Promise<Refund> {
    await this.transactions.runInTransaction(async (manager) => {
      await this.refunds.markFailed(manager, refund.id, reason);
      // The money is the merchant's again: undo the reservation the create transaction made.
      await this.charges.addRefundedAmount(manager, refund.charge_id, -Number(refund.amount_minor));

      await this.events.publish(
        'refund.failed',
        {
          refund_id: refund.id,
          charge_id: refund.charge_id,
          merchant_id: scope.merchantId,
          amount_minor: Number(refund.amount_minor),
          currency: refund.currency,
          failure_reason: reason,
          failed_at: this.clock.nowIso(),
        },
        {
          merchantId: scope.merchantId,
          correlationId: refund.id,
          causationId: null,
          livemode: scope.livemode,
          occurredAt: this.clock.nowIso(),
        },
      );
    });

    this.logger.warn('refund_failed', { refund_id: refund.id, charge_id: refund.charge_id, reason });

    refund.status = 'failed';
    refund.failure_reason = reason;
    return toRefund(refund);
  }

  /**
   * `ProcessorWebhookService`'s `refund_settled` branch. The acquirer's asynchronous verdict
   * on a refund we already submitted; the synchronous response is usually right, but a
   * reversal can still fail in the file two days later.
   *
   * Returns null for an unknown reference — acquirers replay refunds for merchants who have
   * left, and there is nothing to update. Re-delivery of an already-settled refund is a no-op
   * because both writes are guarded on `status = 'pending'`.
   */
  async markSettledFromWebhook(
    processorReference: string,
    outcome: { failed: boolean; failureReason: string },
  ): Promise<RefundEntity | null> {
    const row = await this.findOneOrThrow(refundId, scopeFrom(principal));
    return toRefund(row);
  }

  async list(
    principal: AuthPrincipal,
    query: ListQuery & { charge_id?: ChargeId },
  ): Promise<Paginated<Refund>> {
    const scope = scopeFrom(principal);
    const page = await this.paginate(query, scope, (qb) =>
      query.charge_id ? qb.andWhere('refund.charge_id = :chargeId', { chargeId: query.charge_id }) : qb,
    );

    return { ...page, data: page.data.map(toRefund) };
  }

  /** Used by the charge detail panel; not paginated because a charge has a handful. */
  async listForCharge(principal: AuthPrincipal, chargeId: ChargeId): Promise<Refund[]> {
    const rows = await this.refunds.findAllForCharge(chargeId);
    const scope = scopeFrom(principal);
    // TODO(PAY-1988): filter in SQL. This is a scoped-repository method waiting to happen.
    return rows.filter((row) => row.merchantId === scope.merchantId).map(toRefund);
  }
}

/** One scope tuple per request, built from the principal the guard chain attached. */
function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

export function toRefund(row: RefundEntity): Refund {
  return {
    id: row.id,
    object: 'refund',
    merchant_id: row.merchantId,
    charge_id: row.charge_id,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    failure_reason: row.failure_reason,
    processor_reference: row.processor_reference,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    succeeded_at: row.succeeded_at ? row.succeeded_at.toISOString() : null,
  };
}
