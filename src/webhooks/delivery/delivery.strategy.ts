import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';
import type { WebhookEventEntity } from '../webhook-event.entity';
import type { DeliveryResult } from './delivery.types';

/**
 * How a `webhook_event` is put on the wire.
 *
 * Two implementations because a handful of long-standing merchants integrated against a
 * form-encoded body before the JSON one existed and have never migrated. `hlegacy` says
 * three of them are still live and one of them is our second-largest by volume, so the
 * form strategy is not going anywhere.
 */
export interface WebhookDeliveryStrategy {
  readonly name: 'http-json' | 'http-form';

  deliver(event: WebhookEventEntity, endpoint: WebhookEndpointEntity): Promise<DeliveryResult>;

  /** HMAC-SHA256 over `"{timestamp}.{body}"`, hex. Shared by both strategies. */
  sign(body: string, secret: string, timestamp: number): string;
}

export function strategyNameForUrl(url: string): DeliveryStrategyName {
  return url.includes('format=form') ? 'http-form' : 'http-json';
}

