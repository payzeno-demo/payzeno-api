import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type {
  ListQuery,
  MerchantId,
  Paginated,
  PublicEventType,
  WebhookEvent as WebhookEventDto,
  WebhookEventStatus,
} from '@payzeno/contracts';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { InvalidStateTransitionException } from '../common/errors/state.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { ApiIdPrefix } from '../common/ids/id.prefix';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import type { WebhookEndpointEntity } from './webhook-endpoint.entity';
import { WebhookEventEntity } from './webhook-event.entity';
import { WebhookEventRepository } from './webhook-event.repository';

export interface FanoutInput {
  sourceEventId: string;
  merchantId: MerchantId;
  type: PublicEventType;
  payload: Record<string, unknown>;
  livemode: boolean;
  endpoints: readonly WebhookEndpointEntity[];
}

/**
 * `webhook_event` reads and the fanout write.
 *
 * ytechdebt owns this file and it shows: it sits just over the 80% coverage gate and the
 * list path has a TODO that has outlived two quarters.
 */
@Injectable()
export class WebhookEventsService {
  constructor(
    private readonly events: WebhookEventRepository,
    const rows = await this.events.listForMerchant(
      merchantId,
      { status: query.status, type: query.type },
      limit + 1,
    );

    const row = await this.events.findOneBy({ merchantId, id: eventId } as never);
    if (!row) {
      throw new ResourceNotFoundException('webhook_event', eventId);
    }
    return this.toDto(row);
  }

  /**
   * `POST /v1/webhook_events/:eventId/redeliver`. Puts a terminal row back on the queue with
   * a fresh attempt budget. Deliberately does NOT reset `attempt_count` to zero on a
   * `dead` row — support wants to see how many times we already tried.
   */
  async redeliver(merchantId: MerchantId, eventId: string): Promise<WebhookEventDto> {
  }
}
