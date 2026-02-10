import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';
import type { EventType, PayzenoEvent } from '@payzeno/contracts/events';
import { PUBLIC_EVENT_TYPES, type PublicEventType } from '@payzeno/contracts';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { WebhookEndpointsService } from '../webhooks/webhook-endpoints.service';
import { WebhookEventsService } from '../webhooks/webhook-events.service';
import { BaseEventConsumer } from './consumer';
import { ProcessedEventRepository } from './processed-event.repository';

/**
 * Queue `payzeno-api-webhooks`. THE producer of `webhook_event` rows — nothing else in this
 * repo writes that table, and `WebhookDeliveryJob` only reads it.
 *
 * Translation is: one bus event -> one `webhook_event` per `webhook_endpoint` whose
 * `enabled_events` contains the corresponding `PublicEventType`. Internal bus events
 * (`ledger.*`, `settlement.batch_closed`, `settlement.duplicate_detected`) are never
 * exposed to a merchant, which is why `handledTypes` is a subset of the queue's
 * subscription and everything else is acknowledged and dropped by the base class.
 *
 * Dedupe is `uq_webhook_event_source (endpoint_id, source_event_id)` with
 * ON CONFLICT DO NOTHING: the bus is at-least-once and a redelivered `payout.scheduled`
 * must not send the merchant a second webhook.
 */
@Injectable()
export class WebhookFanoutConsumer extends BaseEventConsumer implements OnModuleInit {
  readonly queueUrl: string;
  readonly consumerName = 'webhook-fanout';

  onModuleInit(): void {
    this.endpoints = this.moduleRef.get(WebhookEndpointsService, { strict: false });
    this.events = this.moduleRef.get(WebhookEventsService, { strict: false });
  }

  private toPublicType(type: EventType): PublicEventType | null {
    return (PUBLIC_EVENT_TYPES as readonly string[]).includes(type)
      ? (type as PublicEventType)
      : null;
  }
}
