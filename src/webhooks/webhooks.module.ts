import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiModule } from '../api/api.module';
import { CommonModule } from '../common/common.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { HttpFormDeliveryStrategy } from './delivery/http-form.strategy';
import { HttpJsonDeliveryStrategy } from './delivery/http-json.strategy';
import { WEBHOOK_DELIVERY_STRATEGIES } from './delivery/delivery.strategy';
import { WebhookSecretService } from './secret/webhook-secret.service';
import { WebhookDeliveryStateMachine } from './state/webhook-delivery.state-machine';
import { WebhookEndpointEntity } from './webhook-endpoint.entity';
import { WebhookEndpointRepository } from './webhook-endpoint.repository';
import { WebhookEndpointsController } from './webhook-endpoints.controller';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookEventEntity } from './webhook-event.entity';
import { WebhookEventRepository } from './webhook-event.repository';
import { WebhookEventsController } from './webhook-events.controller';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Outbound webhooks.
 *
 * Note what is NOT here: the fanout consumer (it lives in `src/events/`, on the bus side)
 * and the delivery job (it lives in `src/jobs/`). This module owns the endpoints, the
 * events table, the secrets and the two wire strategies — the two schedulers reach in.
 */
@Module({
  imports: [
    CommonModule,
    ApiModule,
