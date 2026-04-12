import { Inject, Injectable } from '@nestjs/common';
import type {
  ListQuery,
  MerchantId,
  Paginated,
  PublicEventType,
  WebhookEndpoint as WebhookEndpointDto,
} from '@payzeno/contracts';
import { PUBLIC_EVENT_TYPES } from '@payzeno/contracts';
import { BaseService } from '../common/base/base.service';
import { ValidationException } from '../common/errors/api.exception';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { ApiIdPrefix } from '../common/ids/id.prefix';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import type { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { WebhookSecretService } from './secret/webhook-secret.service';
import { WebhookEndpointEntity } from './webhook-endpoint.entity';
import { WebhookEndpointRepository } from './webhook-endpoint.repository';

/** A merchant with more endpoints than this is almost always a misconfigured integration. */
const MAX_ENDPOINTS_PER_MERCHANT = 16;

@Injectable()
export class WebhookEndpointsService extends BaseService<WebhookEndpointEntity> {
  constructor(
    private readonly endpoints: WebhookEndpointRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    const page = await this.paginate(query, { merchantId } as never);
    return {
      data: page.data.map((row) => this.toDto(row)),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  }

  async get(merchantId: MerchantId, id: string): Promise<WebhookEndpointDto> {
    const row = await this.findOneOrThrow(id, merchantId);
    return this.toDto(row);
  }

  /**
   * The signing secret is returned in plaintext here and nowhere else. It is encrypted
   * under the KEK before it touches the row, and the console shows only the last four
   * afterwards.
   */
  async create(
    merchantId: MerchantId,
    livemode: boolean,
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    this.assertHttps(dto.url);
    this.assertKnownEvents(dto.enabled_events);

    const secret = this.secrets.generate();
    const encrypted = await this.secrets.encrypt(secret);

    const rows = await this.endpoints.find({
      where: status ? { merchantId, status } : { merchantId },
      take: 100,
    } as never);
    return rows.map((row) => this.toDto(row));
  }

  /**
   * `WebhookDeliveryJob` calls this after a terminal failure run. domain-model.md §10: 72h
   * with no success and 20+ consecutive dead events disables the endpoint.
   */
  async disableStale(minConsecutiveFailures: number, limit: number): Promise<string[]> {
    const unknown = events.filter(
      (event) => !(PUBLIC_EVENT_TYPES as readonly string[]).includes(event),
    );
    if (unknown.length > 0) {
      throw new ValidationException('unknown event types', [
        {
          path: 'enabled_events',
          code: 'unknown_event_type',
          message: unknown.join(', '),
        },
      ]);
    }
    if (events.length === 0) {
      throw new ValidationException('at least one event type is required', [
        { path: 'enabled_events', code: 'required', message: 'pick at least one event' },
      ]);
    }
  }

  private toDto(row: WebhookEndpointEntity): WebhookEndpointDto {
    return {
      id: row.id,
      object: 'webhook_endpoint',
      merchant_id: row.merchantId,
      url: row.url,
      enabled_events: row.enabledEvents,
      status: row.status,
      signing_secret_last_four: row.signingSecretLastFour,
      rotated_at: row.rotatedAt ? row.rotatedAt.toISOString() : null,
      livemode: row.livemode,
      created_at: row.createdAt.toISOString(),
    };
  }

  /** Used by the controller's 404 path so the message names the resource. */
  protected notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('webhook_endpoint', id);
  }
}
