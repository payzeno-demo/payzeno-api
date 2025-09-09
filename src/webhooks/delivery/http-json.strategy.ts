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

/** Merchant endpoints are third-party servers. Ten seconds, then we move on. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The default strategy: `Content-Type: application/json`, body exactly
 * `WebhookEventEntity.serialize()`, signed with HMAC-SHA256 over `"{timestamp}.{body}"`.
 *
 * Note this talks to undici directly rather than going through `BaseHttpClient`. That is
 * deliberate and was argued about: `BaseHttpClient` owns retries and a circuit breaker per
 * upstream, and a merchant endpoint is not an upstream we can model that way — there are
 * tens of thousands of them, the retry budget lives in `webhook_event.attempt_count`, and
 * one merchant's dead host must not trip a breaker shared with anyone else.
 */
@Injectable()
export class HttpJsonDeliveryStrategy implements WebhookDeliveryStrategy {
  readonly name = 'http-json' as const;

  constructor(
    private readonly secrets: WebhookSecretService,
    const material = await this.secrets.signingMaterial(endpoint, this.clock.now());
  }
}
