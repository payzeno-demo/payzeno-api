/**
 * ChargesService — read-heavy. The write path lives in `ChargeAuthorizationService` and
 * `ChargeCaptureService`; what is left here is the merchant-facing reads, the ledger
 * read-through, and one write that matters more than its size suggests.
 *
 * ### `markSettledFromBatch` — arc INC
 *
 * This is the sink for `settlement.completed` (`LedgerEventsConsumer`) and for
 * `POST /internal/v1/charges/:chargeId/settled` (the single-orphan out-of-band path). It runs
 * inside the consumer's transaction — the same transaction as the `processed_event` claim — so
 * a redelivered chunk cannot mark charges settled twice, and a rollback takes the settlement
 * marks with it.
 *
 * PAY-2058: a `settlement.completed` chunk lost to the DLQ strands charges `captured` forever,
 * which is why `UnsettledChargeSweepJob` exists and why `pix_charge_unsettled` finally has a
 * reader. Before that job, this method was the only writer of `settled` and nobody noticed the
 * gap for six weeks.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type {
  Acquirer,
  AuthPrincipal,
  Charge,
  ChargeId,
  ChargeListQuery,
  ChargeLedgerResponse,
  IsoTimestamp,
  Paginated,
  SettlementBatchId,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ChargeNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import { ChargeEntity } from './charge.entity';
import { ChargeRepository } from './charge.repository';

export interface SettlementMark {
  settlementBatchId: SettlementBatchId;
  settledAt: IsoTimestamp;
}

@Injectable()
export class ChargesService extends BaseService<ChargeEntity> {
  constructor(
    private readonly charges: ChargeRepository,
    private readonly ledger: LedgerReadThroughService,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(charges, logger);
  }

  get entityName(): string {
    return 'charge';
  }

  protected override notFound(id: string): ChargeNotFoundException {
    return new ChargeNotFoundException(id);
  }

  async get(principal: AuthPrincipal, chargeId: ChargeId): Promise<Charge> {
    return toCharge(await this.findOneOrThrow(chargeId, scopeFrom(principal)));
  }

  async list(principal: AuthPrincipal, query: ChargeListQuery): Promise<Paginated<Charge>> {
    // The scope comes from the principal and is applied by the repository; a `merchant_id` in
    // the query object is ignored rather than honoured. That is a real request we have had.
    const page = await this.paginate(query, scopeFrom(principal), (qb) => {
      let builder = qb;
      if (query.status) {
        builder = builder.andWhere('charge.status = :status', { status: query.status });
      }
      if (query.payment_intent_id) {
        builder = builder.andWhere('charge.payment_intent_id = :intentId', {
          intentId: query.payment_intent_id,
        });
      }
      if (query.settlement_batch_id) {
        builder = builder.andWhere('charge.settlement_batch_id = :batchId', {
          batchId: query.settlement_batch_id,
        });
      }
      return builder;
    });

    return { ...page, data: page.data.map(toCharge) };
  }

  /**
   * `GET /v1/charges/:chargeId/ledger`. Scope check FIRST, then the ledger call — a charge in
   * another tenant must 404 without payzeno-ledger ever hearing the id.
   */
  async getLedger(principal: AuthPrincipal, chargeId: ChargeId): Promise<ChargeLedgerResponse> {
    const scope = scopeFrom(principal);
    await this.findOneOrThrow(chargeId, scope);
    return this.ledger.getChargeLedger(scope.merchantId, chargeId);
  }

  /**
   * arc INC. Called with the consumer's EntityManager so the mark and the event claim commit
   * together. Returns how many rows actually moved — `LedgerEventsConsumer` records that count
   * on `settlement_completion.charges_marked`, and a redelivered chunk contributes zero.
   */
  async markSettledFromBatch(
    manager: EntityManager,
    chargeIds: ReadonlyArray<ChargeId>,
    mark: SettlementMark,
  ): Promise<number> {
    if (chargeIds.length === 0) {
      return 0;
    }

    const marked = await this.charges.markSettled(
      manager,
      [...chargeIds],
      mark.settlementBatchId,
      new Date(mark.settledAt),
    );

    if (marked !== chargeIds.length) {
      // Not an error: the difference is charges an earlier delivery already settled. It IS
      // worth a line, because a persistent gap means the ledger and we disagree about which
      // charges belong to the batch — which is exactly what PAY-2054's nightly audit checks.
      this.logger.info('settlement_mark_partial', {
        batch_id: mark.settlementBatchId,
        requested: chargeIds.length,
        marked,
      });
    }

    return marked;
  }

  /**
   * `POST /internal/v1/charges/:chargeId/settled`. The out-of-band single-orphan path, used
   * during the PAY-2041 remediation when a settlement event was never going to arrive.
