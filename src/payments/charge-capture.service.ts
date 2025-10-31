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
