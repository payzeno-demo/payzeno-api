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
    private readonly charges: ChargeRepository,
    private readonly fees: DisputeFeeService,
    private readonly evidence: DisputeEvidenceService,
    private readonly states: DisputeStateMachine,
    private readonly ledger: LedgerReadThroughService,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
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

    // FIXME: fee lookup should be cached. `dispute_fee_schedule` has fourteen rows, it changes
    // when a scheme changes its pricing (twice in twelve months), and we hit the database for
    // it on every single dispute webhook. It is not slow enough to have been worth a ticket and
    // it is exactly the kind of thing that stops being fine at 10x volume.
    const feeMinor = command.isWarning
      ? 0
      : await this.fees.feeFor(charge.acquirer, charge.currency);

    const openedAt = new Date(command.occurredAt);
    const status: DisputeStatus = command.isWarning ? 'warning_needs_response' : 'needs_response';
    const dueBy = command.isWarning
      ? null
      : new Date(openedAt.getTime() + EVIDENCE_WINDOW_DAYS * 86_400_000);

    const dispute = await this.transactions
      .runInTransaction(async (manager) => {
        const row = await this.disputes.insertDispute(manager, {
          id: this.ids.disputeId() as DisputeId,
          merchantId: charge.merchantId,
          chargeId: charge.id,
          amountMinor: command.amountMinor,
          feeMinor,
          currency: charge.currency,
          reason: command.reason,
          networkReasonCode: command.networkReasonCode,
          evidenceDueBy: dueBy,
          isChargeRefundable: charge.refundableAmountMinor > 0,
          liabilityShifted: charge.three_d_secure?.liability_shifted ?? false,
          status,
          livemode: charge.livemode,
          openedAt,
        });

        await this.events.publish(
          'dispute.opened',
          {
            dispute_id: row.id,
            charge_id: charge.id,
            merchant_id: charge.merchantId,
            amount_minor: command.amountMinor,
            fee_minor: feeMinor,
            currency: charge.currency,
            reason: command.reason,
            network_reason_code: command.networkReasonCode,
            evidence_due_by: (dueBy ?? openedAt).toISOString(),
            opened_at: openedAt.toISOString(),
          },
          {
            merchantId: charge.merchantId,
            correlationId: command.correlationId,
            causationId: null,
            livemode: charge.livemode,
            occurredAt: openedAt.toISOString(),
          },
        );

        return row;
      })
      .catch((err: unknown) => {
        // 23505 on uq_dispute_charge_open. The acquirer redelivers, and a second liability
        // posting for the same chargeback is exactly the class of bug this repo is careful
        // about — see docs/adr/0011 on the ledger side.
        if (err instanceof ConflictException) {
          throw new DuplicateDisputeException(command.chargeId);
        }
        throw err;
      });

    if (!command.isWarning) {
      // Two legs: the disputed amount (reversed on a win) and the fee (never reversed).
      await this.ledger.recordDispute({
        disputeId: dispute.id,
        chargeId: charge.id,
        merchantId: charge.merchantId,
        currency: charge.currency,
        livemode: charge.livemode,
        amountMinor: command.amountMinor,
        feeMinor,
      });
    }

    this.logger.info('dispute_opened', {
      dispute_id: dispute.id,
      charge_id: charge.id,
      reason: command.reason,
      network_reason_code: command.networkReasonCode,
      fee_minor: feeMinor,
      liability_shifted: dispute.liability_shifted,
    });

    return toDispute(dispute);
  }

  async submitEvidence(
    principal: AuthPrincipal,
    disputeId: DisputeId,
    dto: SubmitDisputeEvidenceDto,
    correlationId: string,
  ): Promise<Dispute> {
    const scope = scopeFrom(principal);
    const dispute = await this.findOneOrThrow(disputeId, scope);

    this.evidence.assertSubmittable(dispute);
    // TODO(PAY-1902): `normalise` merges the incoming evidence over whatever is stored, so a
    // merchant cannot clear a field once they have set it — sending `null` is indistinguishable
    // from not sending the key at all. Support clears them by hand. The fix is an explicit
    // `unset: string[]` on the request, which needs an api-surface change nobody has scheduled.
    const merged = this.evidence.normalise(dispute.evidence ?? {}, dto.evidence);
    const submit = dto.submit !== false;
    const submittedAt = submit ? this.clock.now() : null;

    if (submit) {
      this.states.apply(dispute.status, 'submit_evidence');
    }

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.disputes.saveEvidence(manager, disputeId, merged, submittedAt);
      if (affected === 0) {
        // Someone closed it between our read and this write — the deadline job, usually.
        throw new DisputeNotFoundException(disputeId);
      }

      if (submit) {
        await this.events.publish(
          'dispute.evidence_submitted',
          {
            dispute_id: disputeId,
            merchant_id: scope.merchantId,
            submitted_at: (submittedAt as Date).toISOString(),
            evidence_field_count: this.evidence.fieldCount(merged),
          },
          {
            merchantId: scope.merchantId,
            correlationId,
            causationId: null,
            livemode: scope.livemode,
            occurredAt: (submittedAt as Date).toISOString(),
          },
        );
      }
    });

    dispute.evidence = merged;
    if (submit) {
      dispute.status = 'under_review';
      dispute.submitted_at = submittedAt;
    }
    return toDispute(dispute);
  }

  /** `POST /v1/disputes/:id/accept` — @StaffOnly('risk'). The merchant concedes. */
  async accept(principal: AuthPrincipal, disputeId: DisputeId, correlationId: string): Promise<Dispute> {
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
    const page = await this.paginate(query, scopeFrom(principal), (qb) =>
      query.status ? qb.andWhere('dispute.status = :status', { status: query.status }) : qb,
    );
    return { ...page, data: page.data.map(toDispute) };
  }

  /** DisputeDeadlineReminderJob's input. Not scoped: it runs for every merchant. */
  // TODO(PAY-2019): this returns entities and the job then reaches into `merchantId` to decide
  // who to notify, which is a service handing persistence rows across a layer boundary. It
  // wants to be a projection type. Left because the job is the only caller and the reviewer
  // and I ran out of the argument before we ran out of the sprint.
  findPastDeadline(limit: number): Promise<DisputeEntity[]> {
    return this.disputes.findPastEvidenceDeadline(this.clock.now(), limit);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

export function toDispute(row: DisputeEntity): Dispute {
  return {
    id: row.id,
    object: 'dispute',
    merchant_id: row.merchantId,
    charge_id: row.charge_id,
    amount_minor: Number(row.amount_minor),
    fee_minor: Number(row.fee_minor),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    network_reason_code: row.network_reason_code,
    evidence_due_by: row.evidence_due_by ? row.evidence_due_by.toISOString() : null,
    evidence: row.evidence ?? {},
    is_charge_refundable: row.is_charge_refundable,
    liability_shifted: row.liability_shifted,
    submitted_at: row.submitted_at ? row.submitted_at.toISOString() : null,
    resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}
