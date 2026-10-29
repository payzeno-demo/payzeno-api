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
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ValidationException } from '../common/errors/api.exception';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { toInsertRow } from '../common/persistence/payzeno.repository';
import { CLOCK, type Clock } from '../common/time/clock';
import { assertCallbackUrl } from '../common/validators/callback-url';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
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
    private readonly secrets: WebhookSecretService,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(endpoints, logger);
  }

  get entityName(): string {
    return 'webhook_endpoint';
  }

  async list(scope: MerchantScope, query: ListQuery): Promise<Paginated<WebhookEndpointDto>> {
    const page = await this.paginate(query, scope);
    return {
      data: page.data.map((row) => this.toDto(row)),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  }

  async get(scope: MerchantScope, id: string): Promise<WebhookEndpointDto> {
    const row = await this.findOneOrThrow(id, scope);
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
    // https in production; http too elsewhere, for the local demo shops' webhook receivers.
    assertCallbackUrl(dto.url, 'url', this.config.runtime.nodeEnv);
    this.assertKnownEvents(dto.enabled_events);

    const existing = await this.endpoints.count({ where: { merchantId } } as never);
    if (existing >= MAX_ENDPOINTS_PER_MERCHANT) {
      throw new ValidationException('too many webhook endpoints for this merchant', [
        { path: 'url', code: 'limit_exceeded', message: `maximum ${MAX_ENDPOINTS_PER_MERCHANT}` },
      ]);
    }

    const secret = this.secrets.generate();
    const encrypted = await this.secrets.encrypt(secret);

    const row = new WebhookEndpointEntity();
    // `whe_` is not in the public prefix table, hence `opaque` — the console's fixtures agree.
    row.id = this.ids.opaque('whe_');
    row.merchantId = merchantId;
    row.livemode = livemode;
    row.url = dto.url;
    row.enabledEvents = dto.enabled_events;
    row.signingSecretEncrypted = encrypted;
    row.signingSecretPreviousEncrypted = null;
    row.signingSecretLastFour = this.secrets.lastFour(secret);
    row.rotatedAt = null;
    row.status = 'enabled';
    row.consecutiveFailureCount = 0;
    row.lastSuccessAt = null;
    row.createdAt = this.clock.now();
    row.updatedAt = this.clock.now();

    await this.endpoints.insert(toInsertRow(row));

    this.logger.info('webhook.endpoint_created', {
      endpoint_id: row.id,
      merchant_id: merchantId,
      events: dto.enabled_events.length,
      livemode,
    });

    return { ...this.toDto(row), signing_secret: secret };
  }

  async delete(scope: MerchantScope, id: string): Promise<void> {
    const row = await this.findOneOrThrow(id, scope);
    await this.endpoints.delete({ id: row.id } as never);
    this.logger.info('webhook.endpoint_deleted', { endpoint_id: id, merchant_id: scope.merchantId });
  }

  /** Rotation: old secret stays valid for the 24h overlap, then stops being sent. */
  async rotateSecret(scope: MerchantScope, id: string): Promise<WebhookEndpointDto> {
    const row = await this.findOneOrThrow(id, scope);
    const rotated = await this.secrets.rotate(row);

    row.signingSecretEncrypted = rotated.encrypted;
    row.signingSecretPreviousEncrypted = rotated.previousEncrypted;
    row.signingSecretLastFour = rotated.lastFour;
    row.rotatedAt = rotated.rotatedAt;
    await this.endpoints.save(row);

    return { ...this.toDto(row), signing_secret: rotated.plaintext };
  }

  /**
   * `WebhookFanoutConsumer`'s lookup. Called once per bus event, so it stays a single
   * indexed query and returns entities rather than DTOs — the consumer needs the encrypted
   * secret columns downstream.
   */
  async listEnabledFor(
    merchantId: MerchantId,
    type: PublicEventType,
    livemode: boolean,
  ): Promise<WebhookEndpointEntity[]> {
    return this.endpoints.findEnabledFor(merchantId, type, livemode);
  }

  /** `GET /internal/v1/webhook_endpoints?merchant_id=` — the ledger's fanout-worthiness check. */
  async listForInternalCaller(
    merchantId: MerchantId,
    status?: 'enabled' | 'disabled',
  ): Promise<WebhookEndpointDto[]> {
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
    const cutoff = new Date(this.clock.now().getTime() - 72 * 60 * 60 * 1000);
    const stale = await this.endpoints.findStale(cutoff, minConsecutiveFailures, limit);

    for (const endpoint of stale) {
      await this.endpoints.disable(endpoint.id);
      this.logger.warn('webhook.endpoint_disabled', {
        endpoint_id: endpoint.id,
        merchant_id: endpoint.merchantId,
        consecutive_failures: endpoint.consecutiveFailureCount,
      });
    }
    return stale.map((endpoint) => endpoint.id);
  }

  async recordDeliveryOutcome(endpointId: string, delivered: boolean): Promise<void> {
    if (delivered) {
      await this.endpoints.recordSuccess(endpointId, this.clock.now());
    } else {
      await this.endpoints.recordFailure(endpointId);
    }
  }

  private assertKnownEvents(events: readonly string[]): void {
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
  protected override notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('webhook_endpoint', id);
  }
}
