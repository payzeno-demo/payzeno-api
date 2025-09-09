import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { WebhookSecretService } from '../secret/webhook-secret.service';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';
import type { WebhookEventEntity } from '../webhook-event.entity';
import type { WebhookDeliveryStrategy } from './delivery.strategy';
import {
  type DeliveryResult,
  formatSignatureHeader,
  isSuccessStatus,
  SIGNATURE_HEADER,
} from './delivery.types';

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * `application/x-www-form-urlencoded`. Predates the JSON strategy.
 *
 * Kept because three merchants integrated against it in year one and one of them is our
 * second-largest by volume. Their parsers cannot read a nested object, so the payload is
 * FLATTENED to one level with dotted keys — `data.object.amount_minor` — and the signature
 * is computed over the encoded form body, not over the JSON. Deleting this is a
 * customer-migration project, not a refactor.
 */
@Injectable()
export class HttpFormDeliveryStrategy implements WebhookDeliveryStrategy {
  readonly name = 'http-form' as const;

  constructor(
    private readonly secrets: WebhookSecretService,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async deliver(event: WebhookEventEntity, endpoint: WebhookEndpointEntity): Promise<DeliveryResult> {
  }
}
