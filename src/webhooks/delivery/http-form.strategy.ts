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
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async deliver(event: WebhookEventEntity, endpoint: WebhookEndpointEntity): Promise<DeliveryResult> {
    const startedAt = Date.now();
    const body = this.encode(event);
    const signatures = [this.sign(body, material.current, timestamp)];
    if (material.previous) {
      signatures.push(this.sign(body, material.previous, timestamp));
    }

    try {
      const response = await request(endpoint.url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Payzeno/1.0 (+https://payzeno.com/docs/webhooks)',
          [SIGNATURE_HEADER.toLowerCase()]: formatSignatureHeader(timestamp, signatures),
          'payzeno-event-id': event.id,
          'payzeno-event-type': event.type,
        },
        headersTimeout: DELIVERY_TIMEOUT_MS,
        bodyTimeout: DELIVERY_TIMEOUT_MS,
      });

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
        strategy: this.name,
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

  /**
   * Flatten to dotted keys. Arrays become indexed keys (`lines.0.amount_minor`) because the
   * two remaining integrations both parse that shape — it is what PHP's `http_build_query`
   * produces and that is what they were written against.
   */
  private encode(event: WebhookEventEntity): string {
  }
}
