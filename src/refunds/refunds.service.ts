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
    private readonly router: ProcessorRouter,
    private readonly ids: IdFactory,
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
    const page = await this.paginate(query, scope, (qb) =>
      query.charge_id ? qb.andWhere('refund.charge_id = :chargeId', { chargeId: query.charge_id }) : qb,
    );

    return { ...page, data: page.data.map(toRefund) };
  }

  /** Used by the charge detail panel; not paginated because a charge has a handful. */
  async listForCharge(principal: AuthPrincipal, chargeId: ChargeId): Promise<Refund[]> {
  };
}
