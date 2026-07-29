/**
 * Capture. The hottest file on the money path — arc PCI took the PAN out of it, arc INC put
 * the `capture_at_settlement` branch in it, and arc MIG moved the fee posting out of it.
 *
 * Frame 4 of the repo's deepest chain:
 *   PaymentIntentsController.capture → PaymentIntentsService.capture → CapturePaymentFlow.execute
 *   → **ChargeCaptureService.captureCharge** → ProcessorRouter.select → WorldflowAdapter.capture
 *   → AcquirerHttpClient → BaseHttpClient.request → UndiciTransport.send
 *
 * and the persistence and event chains hang off this frame (blueprint §0).
 *
 * ### `capture_at_settlement` — read this before changing the branch below
 *
 * For merchants with `merchant.capture_at_settlement = true` (eleven of them, all travel and
 * lodging MCCs, PAY-1652) payzeno-api does **not** issue the physical capture. payzeno-ledger
 * issues it during settlement posting, from `SettlementPoster.post_settlement`. This service
 * marks the charge `captured` and emits `payment.captured`; the acquirer call happens later,
 * elsewhere, on a different schedule.
 *
 * That is the branch that turned a duplicate ledger posting into 218 duplicate cardholder
 * charges on the night of PAY-2041. It is correct, it is still here, and the postmortem's
 * action items are on the ledger side. See docs/runbooks/payzeno-api.md §"duplicate settlement
 * remediation" and payzeno-ledger/docs/postmortems/2041-duplicate-settlement.md.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Merchant } from '@payzeno/contracts';

import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { ChargeNotCapturableException } from '../common/errors/state.exceptions';
import { CLOCK, type Clock } from '../common/time/clock';
import { LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { ChargeEntity } from './charge.entity';
import { ChargeRepository } from './charge.repository';
import { ChargeStateMachine } from './state/charge.state-machine';
import { ProcessorRouter } from './processor/processor.router';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import { ledgerKey } from '../ledger/ledger.types';

export interface CaptureChargeCommand {
  charge: ChargeEntity;
  merchant: Merchant;
  /** Defaults to the full authorised amount. Must be ≤ authorised. */
  amountMinor?: number;
  correlationId: string;
}

export interface CaptureOutcome {
  chargeId: string;
  capturedAmountMinor: number;
  capturedAt: Date;
  /** False when the ledger will issue the acquirer call at settlement instead. */
  processorCaptureIssued: boolean;
}

@Injectable()
export class ChargeCaptureService {
  constructor(
    private readonly charges: ChargeRepository,
    private readonly router: ProcessorRouter,
    private readonly stateMachine: ChargeStateMachine,
    private readonly transactions: TransactionManager,
    private readonly ledger: LedgerReadThroughService,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async captureCharge(command: CaptureChargeCommand): Promise<CaptureOutcome> {
    const { charge, merchant } = command;
    const amountMinor = command.amountMinor ?? Number(charge.amount_minor);

    this.assertCapturable(charge, amountMinor);
    // Throws InvalidStateTransitionException if the charge is not `authorized`.
    this.stateMachine.apply(charge.status, 'capture');

    const deferred = merchant.capture_at_settlement;
    let processorReference = charge.processor_reference ?? '';
    let capturedAt = this.clock.now();

    if (!deferred) {
      const adapter = this.router.forAcquirer(charge.acquirer, { livemode: charge.livemode });
      const result = await adapter.capture({
        networkTransactionId: charge.network_transaction_id ?? '',
        amountMinor,
        currency: charge.currency,
        idempotencyKey: ledgerKey('capture', charge.id),
      });
      if (!result.captured) {
        throw new ChargeNotCapturableException(charge.id, charge.status);
      }
      processorReference = result.processorReference;
      capturedAt = new Date(result.capturedAt);
    } else {
      this.logger.info('capture_deferred_to_settlement', {
        charge_id: charge.id,
        merchant_id: merchant.id,
        acquirer: charge.acquirer,
        // The ledger will issue POST /v2/authorizations/{ntid}/captures when the acquirer's
        // settlement file lands. Nothing in payzeno-api touches the acquirer for this charge.
        network_transaction_id: charge.network_transaction_id,
      });
    }

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.charges.markCaptured(manager, charge.id, {
        capturedAmountMinor: amountMinor,
        processorReference,
        capturedAt,
      });
      if (affected === 0) {
        // Someone else captured between our read and this write. The acquirer honoured the
        // idempotency key, so no second capture happened — but we must not emit a second event.
        throw new ChargeNotCapturableException(charge.id, charge.status);
      }

      await this.events.publish(
        'payment.captured',
        {
          charge_id: charge.id,
          payment_intent_id: charge.payment_intent_id,
          merchant_id: merchant.id,
          captured_amount_minor: amountMinor,
          authorized_amount_minor: Number(charge.amount_minor),
          currency: charge.currency,
          captured_at: capturedAt.toISOString(),
        },
        {
          merchantId: merchant.id,
          correlationId: command.correlationId,
          causationId: null,
          livemode: charge.livemode,
          occurredAt: capturedAt.toISOString(),
        },
      );
    });

    // Synchronous ledger post so the console's balance is right on the next poll. It carries
    // the SAME deterministic key as the event-driven posting the ledger's PaymentEventConsumer
    // makes (`capture:ch_…:`), so whichever arrives second is a no-op on the ledger's side.
    // This is safe precisely because the ledger keys on the business fact and not on an
    // attempt counter (domain-model.md §0.3b).
    await this.ledger.recordCapture({
      chargeId: charge.id,
      merchantId: merchant.id,
      currency: charge.currency,
      livemode: charge.livemode,
      amountMinor,
      platformFeeBps: merchant.platform_fee_bps,
      platformFeeFixedMinor: merchant.platform_fee_fixed_minor,
      reserveBps: merchant.reserve_bps,
    });

    return {
      chargeId: charge.id,
      capturedAmountMinor: amountMinor,
      capturedAt,
      processorCaptureIssued: !deferred,
    };
  }

  private assertCapturable(charge: ChargeEntity, amountMinor: number): void {
    if (charge.status !== 'authorized') {
      throw new ChargeNotCapturableException(charge.id, charge.status);
    }
    if (amountMinor <= 0 || amountMinor > Number(charge.amount_minor)) {
      throw new ChargeNotCapturableException(charge.id, charge.status);
    }
    if (charge.authorization_expires_at && charge.authorization_expires_at.getTime() <= this.clock.now().getTime()) {
      // The hold aged out. ChargeExpiryJob will move it to `expired` on its next pass; we do
      // not do it here, because the acquirer must be told and that is the job's business.
      throw new ChargeNotCapturableException(charge.id, charge.status);
    }
  }
}
