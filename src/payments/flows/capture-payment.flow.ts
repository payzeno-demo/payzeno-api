/**
 * CapturePaymentFlow — frame 3 of the repo's deepest chain (blueprint §0):
 *
 *   PaymentIntentsController.capture → PaymentIntentsService.capture → **CapturePaymentFlow**
 *   → ChargeCaptureService.captureCharge → ProcessorRouter.select → WorldflowAdapter.capture
 *   → AcquirerHttpClient.post → BaseHttpClient.request → UndiciTransport.send
 *
 * The flow owns three things and no more: the FSM transition, the intent write, and the
 * decision about partial amounts. The acquirer call, the ledger posting and
 * `payment.captured` all belong to `ChargeCaptureService`, which is where the
 * `capture_at_settlement` branch lives — the branch that turned one duplicate ledger posting
 * into 218 duplicate cardholder charges on the night of PAY-2041.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CapturePaymentIntentRequest, ChargeId } from '@payzeno/contracts';

import { ValidationException } from '../../common/errors/api.exception';
import { ChargeNotCapturableException } from '../../common/errors/state.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { MerchantsService, toMerchantResponse } from '../../merchants/merchants.service';
import { ChargeCaptureService } from '../charge-capture.service';
import { ChargeRepository } from '../charge.repository';
import { PaymentIntentEntity } from '../payment-intent.entity';
import { PaymentIntentRepository } from '../payment-intent.repository';
import { PaymentIntentStateMachine, type PaymentIntentEvent } from '../state/payment-intent.state-machine';
import { PaymentFlow } from './payment.flow';

@Injectable()
export class CapturePaymentFlow extends PaymentFlow<CapturePaymentIntentRequest> {
  constructor(
    intents: PaymentIntentRepository,
    states: PaymentIntentStateMachine,
    transactions: TransactionManager,
    private readonly charges: ChargeRepository,
    private readonly merchants: MerchantsService,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(intents, states, transactions, logger);
  }

  get flowName(): string {
    return 'payment_intent.capture';
  }

  protected get entryEvent(): PaymentIntentEvent {
    return 'capture';
  }

  async execute(
    intent: PaymentIntentEntity,
    request: CapturePaymentIntentRequest,
  ): Promise<PaymentIntentEntity> {
    // Guard first: an intent in `succeeded` is a double-capture attempt and must cost nothing.
    const landing = this.nextStatus(intent, 'capture');

    const chargeId = intent.latest_charge_id;
    if (!chargeId) {
      throw new ValidationException('This payment intent has no charge to capture', [
        { path: 'latest_charge_id', code: 'missing', message: 'confirm the intent first' },
      ]);
    }

    const amountMinor = this.resolveAmount(intent, request);
    // getById returns the entity; the services below take the contracts type, and the
    // mapping lives in exactly one place (merchants.service.ts).
    const merchant = toMerchantResponse(await this.merchants.getById(intent.merchantId));

    // The acquirer call, the charge write, the outbox event and the ledger posting all happen
    // inside captureCharge — one frame down, where the deferred-capture branch can see the
    // merchant's `capture_at_settlement` flag.
    const outcome = await this.capture.captureCharge({
      charge,
      merchant,
      amountMinor,
      correlationId: intent.id,
    });

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.transition(manager, intent, landing, {
        latest_charge_id: charge.id,
        next_action: null,
      });
      if (affected === 0) {
        // The capture happened but the intent moved under us. Do not roll the capture back:
        // the money is captured and the acquirer honoured our idempotency key. Log loudly.
        this.logger.error('payment_intent_capture_transition_lost', undefined, {
          payment_intent_id: intent.id,
          charge_id: charge.id,
          captured_amount_minor: outcome.capturedAmountMinor,
        });
      }
    });

    this.logger.info('payment_intent_captured', {
      payment_intent_id: intent.id,
      charge_id: charge.id,
      captured_amount_minor: outcome.capturedAmountMinor,
      partial: outcome.capturedAmountMinor < Number(charge.amount_minor),
      processor_capture_issued: outcome.processorCaptureIssued,
    });

    return intent;
  }

  /**
   * Absent `amount_minor` means the full authorised amount. A partial capture releases the
   * remainder of the hold at the acquirer, which is why capturing 1 of 100 twice is not the
   * same as capturing 2 — the second call has 0 left to take.
   */
  private resolveAmount(intent: PaymentIntentEntity, request: CapturePaymentIntentRequest): number {
    const authorised = Number(intent.amount_minor);
    const requested = request.amount_minor ?? authorised;

    if (requested <= 0 || requested > authorised) {
      throw new ValidationException(
        `amount_minor must be between 1 and the authorised ${authorised}`,
        [{ path: 'amount_minor', code: 'out_of_range', message: `must be <= ${authorised}` }],
      );
    }
    return requested;
  }
}
