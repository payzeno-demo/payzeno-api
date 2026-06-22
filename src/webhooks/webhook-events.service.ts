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
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * The ONLY write path into `webhook_event`. Called from `WebhookFanoutConsumer` inside the
   * claim transaction, so a duplicate bus delivery cannot produce a duplicate webhook even
   * if the consumer crashes between the claim and the commit.
   */
  async fanout(tx: EntityManager, input: FanoutInput): Promise<number> {
    const rows = input.endpoints.map((endpoint) => {
      const row = new WebhookEventEntity();
      row.id = this.ids.generate(ApiIdPrefix.WEBHOOK_EVENT);
      row.merchantId = input.merchantId;
      row.endpointId = endpoint.id;
      row.type = input.type;
      row.sourceEventId = input.sourceEventId;
      row.payload = input.payload;
      row.status = 'pending';
      row.attemptCount = 0;
      // Due immediately; WebhookDeliveryJob picks it up on its next 15s tick.
      row.nextAttemptAt = now;
      row.lastResponseStatus = null;
      row.lastError = null;
      row.signatureVersion = 'v1';
      row.livemode = input.livemode;
      row.deliveredAt = null;
      row.createdAt = now;
      row.updatedAt = now;
      return row;
    });

    return this.events.insertIgnoringSourceConflict(tx, rows);
  }

  // TODO(PAY-1866): this ignores query.cursor and always returns the newest page. The
  // console does not paginate the events table yet so nobody has noticed.
  async list(
    merchantId: MerchantId,
    query: ListQuery & { status?: WebhookEventStatus; type?: PublicEventType },
  ): Promise<Paginated<WebhookEventDto>> {
    const limit = Math.min(query.limit ?? 25, 100);
    const rows = await this.events.listForMerchant(
      merchantId,
      { status: query.status, type: query.type },
      limit + 1,
    );

    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map((row) => this.toDto(row)),
      next_cursor: hasMore ? page[page.length - 1].id : null,
      has_more: hasMore,
    };
  }

  async get(merchantId: MerchantId, eventId: string): Promise<WebhookEventDto> {
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
