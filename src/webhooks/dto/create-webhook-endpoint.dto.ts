import { ArrayMaxSize, ArrayNotEmpty, IsIn, IsString, IsUrl } from 'class-validator';
import {
  type CreateWebhookEndpointRequest,
  PUBLIC_EVENT_TYPES,
  type PublicEventType,
} from '@payzeno/contracts';
import { Redact } from '../../common/decorators/redact.decorator';

/**
 * `POST /v1/webhook_endpoints`.
 *
 * Implements the contracts request type rather than restating it — a DTO that redeclares a
 * contracts shape is a review rejection (interfaces.md §2.5).
 *
 * `@Redact('url')` is arc PCI: merchant endpoint URLs routinely carry a query-string token,
 * and those were showing up whole in the structured access log.
 */
@Redact('url')
export class CreateWebhookEndpointDto implements CreateWebhookEndpointRequest {
  @IsString()
  @ArrayNotEmpty()
}
