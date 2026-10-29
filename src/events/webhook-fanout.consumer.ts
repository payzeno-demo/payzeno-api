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

  // The same set the `payzeno-api-webhooks` subscriptions filter for (messaging.tf and the
  // localstack bootstrap). A type missing here is acknowledged and dropped: the payment.*
  // lifecycle was, so a shop fulfilling on `payment.captured` never heard about a payment.
  readonly handledTypes = new Set<EventType>([
    'payment.authorized',
    'payment.captured',
    'payment.canceled',
    'payment.failed',
    'refund.succeeded',
    'refund.failed',
    'dispute.evidence_submitted',
    'payout.scheduled',
    'settlement.item_settled',
  ]);

  private endpoints!: WebhookEndpointsService;
  private events!: WebhookEventsService;

  constructor(
    sqs: SQSClient,
    transactions: TransactionManager,
    processedEvents: ProcessedEventRepository,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly moduleRef: ModuleRef,
  ) {
    super(sqs, transactions, processedEvents, logger);
    this.queueUrl = this.config.aws.sqsApiWebhooksUrl;
  }

  onModuleInit(): void {
    this.endpoints = this.moduleRef.get(WebhookEndpointsService, { strict: false });
    this.events = this.moduleRef.get(WebhookEventsService, { strict: false });
  }

  async handle(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    const publicType = this.toPublicType(event.type);
    if (!publicType) {
      // handledTypes is a subset of PUBLIC_EVENT_TYPES, so this is unreachable unless
      // someone widens the set without checking. Loud, not silent.
      this.logger.error('webhook.fanout_non_public_type', null, { type: event.type });
      return;
    }

    if (!event.merchant_id) {
      // Platform-wide events have no merchant to notify.
      return;
    }

    const endpoints = await this.endpoints.listEnabledFor(
      event.merchant_id,
      publicType,
      event.livemode,
    );

    if (endpoints.length === 0) {
      this.logger.debug('webhook.no_endpoints', {
        merchant_id: event.merchant_id,
        type: publicType,
        livemode: event.livemode,
      });
      return;
    }

    const inserted = await this.events.fanout(tx, {
      sourceEventId: event.id,
      merchantId: event.merchant_id,
      type: publicType,
      payload: event.payload as unknown as Record<string, unknown>,
      livemode: event.livemode,
      endpoints,
    });

    this.logger.info('webhook.fanned_out', {
      source_event_id: event.id,
      merchant_id: event.merchant_id,
      type: publicType,
      endpoints: endpoints.length,
      inserted,
      deduped: endpoints.length - inserted,
    });
  }

  /**
   * Every handled type is already a `PublicEventType` — the merchant vocabulary is a strict
   * subset of the bus vocabulary and the names are identical where they overlap. This is a
   * narrowing, not a mapping table, and it stays a narrowing on purpose: a translation table
   * is where a `settlement.duplicate_detected` eventually leaks to a merchant.
   */
  private toPublicType(type: EventType): PublicEventType | null {
    return (PUBLIC_EVENT_TYPES as readonly string[]).includes(type)
      ? (type as PublicEventType)
      : null;
  }
}
