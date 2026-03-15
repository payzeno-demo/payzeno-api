/**
 * DisputesService — L7. api-surface.md §6, domain-model.md §5.
 *
 * A dispute is never created by a merchant. It arrives on the acquirer webhook
 * (`ProcessorWebhookService`) and is closed by the acquirer, by the merchant accepting
 * liability, or by `DisputeDeadlineReminderJob` when the evidence deadline passes.
 *
 * The one thing worth reading twice is `openFromWebhook`: it inserts first and lets
 * `uq_dispute_charge_open` decide, rather than checking for an open dispute and then
 * inserting. Check-then-act around a side effect is PAY-2041's shape and ADR 0011 forbids it
 * in the money path — and a dispute posts a `chargeback_liability` leg, so this is the money
 * path.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  ChargeId,
  Dispute,
  DisputeId,
  DisputeReason,
  DisputeStatus,
  IsoTimestamp,
  ListQuery,
  Paginated,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ConflictException } from '../common/errors/api.exception';
import { DuplicateDisputeException } from '../common/errors/business.exceptions';
import { ChargeNotFoundException, DisputeNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import { ChargeRepository } from '../payments/charge.repository';
import { DisputeEntity } from './dispute.entity';
import { DisputeEvidenceService } from './dispute-evidence.service';
import { DisputeFeeService } from './dispute-fee.service';
import { DisputeRepository } from './dispute.repository';
import { DisputeStateMachine } from './state/dispute.state-machine';
import { SubmitDisputeEvidenceDto } from './dto/submit-dispute-evidence.dto';

/** Networks give 7-21 days depending on the code; 21 is what both our acquirers grant. */
export const EVIDENCE_WINDOW_DAYS = 21;

export interface OpenDisputeCommand {
  chargeId: ChargeId;
  reason: DisputeReason;
  networkReasonCode: string;
  amountMinor: number;
  /** Early-warning alerts (RDR/Ethoca) open as `warning_needs_response` and move no money. */
  isWarning: boolean;
  occurredAt: IsoTimestamp;
  correlationId: string;
}

@Injectable()
export class DisputesService extends BaseService<DisputeEntity> {
  constructor(
    private readonly disputes: DisputeRepository,
    private readonly evidence: DisputeEvidenceService,
    private readonly transactions: TransactionManager,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(disputes, logger);
  }

  get entityName(): string {
    return 'dispute';
  }

  protected override notFound(id: string): DisputeNotFoundException {
    return new DisputeNotFoundException(id);
  }

  /**
   * The only creation path. Called by ProcessorWebhookService inside the webhook's
   * transaction, so the dispute row and the `processed_event` claim commit together.
   */
  async openFromWebhook(command: OpenDisputeCommand): Promise<Dispute> {
    const charge = await this.charges.findOne({ where: { id: command.chargeId } });
    if (!charge) {
      throw new ChargeNotFoundException(command.chargeId);
    }

    const status: DisputeStatus = command.isWarning ? 'warning_needs_response' : 'needs_response';
    const scope = scopeFrom(principal);
    const scope = scopeFrom(principal);
    const dispute = await this.findOneOrThrow(disputeId, scope);
    const next = this.states.apply(dispute.status, 'accept');

    return this.close(dispute, next as 'lost', correlationId, null);
  }

  /**
   * Shared close path: the network's verdict, the merchant's concession and the deadline job
   * all end here so `dispute.closed` has exactly one emitter.
   */
  async close(
    dispute: DisputeEntity,
    outcome: 'won' | 'lost' | 'warning_closed',
    correlationId: string,
    reversalTransactionId: string | null,
  ): Promise<Dispute> {
    const closedAt = this.clock.now();

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.disputes.transitionStatus(
        manager,
        dispute.id,
        dispute.status,
        outcome,
        closedAt,
      );
      if (affected === 0) {
        throw new DisputeNotFoundException(dispute.id);
      }

      await this.events.publish(
        'dispute.closed',
        {
          dispute_id: dispute.id,
          charge_id: dispute.charge_id,
          merchant_id: dispute.merchantId,
          amount_minor: Number(dispute.amount_minor),
          currency: dispute.currency,
          outcome,
          reversal_transaction_id: reversalTransactionId,
          closed_at: closedAt.toISOString(),
        },
        {
          merchantId: dispute.merchantId,
          correlationId,
          causationId: null,
          livemode: dispute.livemode,
          occurredAt: closedAt.toISOString(),
        },
      );
    });

    this.logger.info('dispute_closed', {
      dispute_id: dispute.id,
      outcome,
      liability_reversed: this.states.reversesLiability(outcome),
    });

    dispute.status = outcome;
    dispute.resolved_at = closedAt;
    return toDispute(dispute);
  }

  /**
   * `ProcessorWebhookService`'s close path — the network's verdict, and the
   * `chargeback_reversed` kind, which resolves an existing dispute rather than opening one.
   *
   * Returns null when there is no open dispute for the charge: acquirers replay their whole
   * file after an outage, and a verdict for a dispute we already closed is noise.
   */
  async closeFromWebhook(
    chargeId: ChargeId,
    outcome: 'won' | 'lost',
    correlationId: string,
  ): Promise<Dispute | null> {
    const open = await this.disputes.findOpenForCharge(chargeId);
    if (!open) {
      this.logger.info('dispute_close_no_open_row', { charge_id: chargeId, outcome });
      return null;
    }

    // Throws InvalidStateTransitionException if the network sends `won` for a dispute the
    // merchant never responded to — which happens, and which we want to see in the logs.
    this.states.apply(open.status, this.states.eventForOutcome(outcome));

    return this.close(open, outcome, correlationId, null);
  }

  async get(principal: AuthPrincipal, disputeId: DisputeId): Promise<Dispute> {
    return toDispute(await this.findOneOrThrow(disputeId, scopeFrom(principal)));
  }

  async list(
    principal: AuthPrincipal,
    query: ListQuery & { status?: DisputeStatus },
  ): Promise<Paginated<Dispute>> {
  };
}
