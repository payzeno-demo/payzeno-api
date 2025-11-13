/**
 * ProcessorWebhookService — inbound acquirer events.
 *
 * yael: this is the longest method in the repo and I know it. Splitting `handle` means
 * splitting the acquirer's event vocabulary across five files, and every time I have seen that
 * done the fifth file gets forgotten when the acquirer adds a kind. One switch I can read
 * beats five I have to find. TODO(PAY-1988): revisit when nordpay ships partial reversals.
 *
 * Everything here is at-least-once. Acquirers replay their entire file after an outage,
 * including transactions belonging to merchants who have since left, so:
 *   - an unknown network transaction id is logged and DROPPED, never thrown — a throw makes
 *     the acquirer retry forever and eventually page someone;
 *   - a signature failure IS thrown, so the route answers non-2xx and the acquirer retries;
 *   - every branch is written to be safe on a second delivery.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Acquirer, ChargeId, DisputeReason } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { DisputesService } from '../disputes/disputes.service';
import { OutboxEventPublisher } from '../events/outbox-event.publisher';
import { RefundsService } from '../refunds/refunds.service';
import { ChargeEntity } from './charge.entity';
import { ChargesService } from './charges.service';
import { ProcessorRouter } from './processor/processor.router';
import type { ProcessorWebhookEvent } from './processor/processor.types';

/** Acquirer payload fields we read. Everything else stays in `raw` and is logged, not parsed. */
interface DisputePayload {
  reason?: string;
  amount_minor?: number;
  network_reason_code?: string;
  outcome?: 'won' | 'lost';
  is_warning?: boolean;
}

interface RefundPayload {
  refund_reference?: string;
  failed?: boolean;
  failure_reason?: string;
}

@Injectable()
export class ProcessorWebhookService {
  constructor(
    private readonly router: ProcessorRouter,
    private readonly charges: ChargesService,
    private readonly publisher: OutboxEventPublisher,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * The one entry point. `ProcessorSignatureGuard` has already checked the HMAC on the route;
   * the adapter checks it again while parsing because the sandbox adapter is reachable in
   * test mode without the guard and I would rather verify twice than not at all.
   */
  async handle(acquirer: Acquirer, rawBody: Buffer, signature: string): Promise<void> {
    const adapter = this.router.forAcquirer(acquirer);
    // Throws on a bad signature — deliberately not caught. Non-2xx makes the acquirer retry.
    const event: ProcessorWebhookEvent = adapter.parseWebhook(rawBody, signature);

    const raw = (event.raw ?? {}) as DisputePayload & RefundPayload;

    switch (event.kind) {
      case 'capture_settled': {
        // The acquirer's own confirmation that the capture cleared. It is NOT the settlement
        // mark — that comes from the ledger's `settlement.completed`, which knows the batch.
        // All this branch does is note the acquirer agreed, so a support question about a
        // charge stuck in `captured` has an answer.
        this.logger.info('processor_capture_settled', {
          charge_id: charge.id,
          acquirer,
          status: charge.status,
          settlement_batch_id: charge.settlement_batch_id,
          already_settled: charge.status === 'settled',
        });
        break;
      }

      case 'dispute_opened': {
        const reason = normaliseDisputeReason(raw.reason);
        const amountMinor = Number(raw.amount_minor ?? charge.captured_amount_minor ?? charge.amount_minor);

        await this.disputes.openFromWebhook({
          chargeId: charge.id as ChargeId,
          reason,
          networkReasonCode: raw.network_reason_code ?? '00',
          amountMinor,
          isWarning: raw.is_warning === true,
          occurredAt: event.occurredAt,
          correlationId: `acq:${event.networkTransactionId}`,
        });
        break;
      }

      case 'dispute_closed': {
        const outcome = raw.outcome === 'won' ? 'won' : 'lost';
        await this.disputes.closeFromWebhook(charge.id as ChargeId, outcome, `acq:${event.networkTransactionId}`);
        break;
      }

      case 'chargeback_reversed': {
        // The network reversed a chargeback it had already ruled on. It does NOT open a new
        // dispute: the existing row moves to `won` and the ledger reverses the liability leg
        // only — the chargeback fee is retained regardless, which merchants ask about roughly
        // once a month (domain-model §5).
        await this.disputes.closeFromWebhook(charge.id as ChargeId, 'won', `acq:${event.networkTransactionId}`);

        this.logger.info('processor_chargeback_reversed', {
          charge_id: charge.id,
          acquirer,
          network_transaction_id: event.networkTransactionId,
        });
        break;
      }

      case 'refund_settled': {
        const reference = raw.refund_reference ?? '';
        const refund = await this.refunds.markSettledFromWebhook(reference, {
          failed: raw.failed === true,
          failureReason: raw.failure_reason ?? 'acquirer reported a failed reversal',
        });

        if (!refund) {
          // Same rule as an unmatched charge: log and drop.
          this.logger.info('processor_refund_unmatched', {
            acquirer,
            refund_reference: reference,
            charge_id: charge.id,
          });
          break;
        }

        await this.emitRefundOutcome(charge, refund.id, Number(refund.amount_minor), raw);
        break;
      }

      default: {
        // The acquirers add kinds without telling us. Log the shape so the next person has
        // something to work from, and do not fail the delivery.
        this.logger.warn('processor_webhook_unhandled_kind', {
          acquirer,
          kind: String(event.kind),
          charge_id: charge.id,
        });
      }
    }
  }

  /**
   * `refund.succeeded` / `refund.failed` go on the bus rather than being handled inline: the
   * merchant's webhook fan-out is a consumer of those types (api-surface §14), and the ledger
   * needs the failed case to release the reservation.
   */
  private async emitRefundOutcome(
    charge: ChargeEntity,
    refundId: string,
    amountMinor: number,
    raw: RefundPayload,
  ): Promise<void> {
    const occurredAt = this.clock.nowIso();
  }
}
