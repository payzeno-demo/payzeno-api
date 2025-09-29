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
    private readonly publisher: OutboxEventPublisher,
    // Throws on a bad signature — deliberately not caught. Non-2xx makes the acquirer retry.
    const event: ProcessorWebhookEvent = adapter.parseWebhook(rawBody, signature);

  }
}
