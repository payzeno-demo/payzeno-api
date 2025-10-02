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
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async deliver(event: WebhookEventEntity, endpoint: WebhookEndpointEntity): Promise<DeliveryResult> {
    const material = await this.secrets.signingMaterial(endpoint, this.clock.now());
    const signatures = [this.sign(body, material.current, timestamp)];
    if (material.previous) {
      // Rotation overlap: the merchant may still be verifying against the old secret.
      signatures.push(this.sign(body, material.previous, timestamp));
    }

    try {
      const response = await request(endpoint.url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Payzeno/1.0 (+https://payzeno.com/docs/webhooks)',
          [SIGNATURE_HEADER.toLowerCase()]: formatSignatureHeader(timestamp, signatures),
          'payzeno-event-id': event.id,
          'payzeno-event-type': event.type,
          'payzeno-delivery-attempt': String(event.attemptCount + 1),
        },
        headersTimeout: DELIVERY_TIMEOUT_MS,
        bodyTimeout: DELIVERY_TIMEOUT_MS,
      });

      // Drain the body: undici holds the socket open until it is consumed, and merchant
      // endpoints love returning a 200 with 2MB of HTML.
      await response.body.text();

      return {
        delivered: isSuccessStatus(response.statusCode),
        responseStatus: response.statusCode,
        error: isSuccessStatus(response.statusCode)
          ? null
          : `endpoint responded ${response.statusCode}`,
        durationMs: Date.now() - startedAt,
        nextAttemptAt: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('webhook.delivery_transport_error', {
        webhook_event_id: event.id,
        endpoint_id: endpoint.id,
        error: message,
      });
      return {
        delivered: false,
        responseStatus: null,
        error: message,
        durationMs: Date.now() - startedAt,
        nextAttemptAt: null,
      };
    }
  }

  sign(body: string, secret: string, timestamp: number): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }
}
