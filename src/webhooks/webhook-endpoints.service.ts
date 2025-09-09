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
    const secret = this.secrets.generate();
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
  }
}
