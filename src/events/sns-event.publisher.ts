import { PublishBatchCommand, PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_SCHEMA_VERSIONS,
  type EventEnvelope,
  type EventType,
  type PayloadOfType,
  type PayzenoEvent,
} from '@payzeno/contracts/events';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { CLOCK, type Clock } from '../common/time/clock';
import { IdFactory } from '../common/ids/id.factory';
import { ApiIdPrefix } from '../common/ids/id.prefix';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { type EventPublisher, topicOf } from './publisher';
import type { PublishContext, TopicName } from './publisher.types';

/**
 * The SNS half of the publish port.
 *
 * Business code must NOT inject this — it injects `EVENT_PUBLISHER`, which is bound to
 * `OutboxEventPublisher`. The only production caller of `SnsEventPublisher` is
 * `OutboxDrainJob`, which republishes rows that a business transaction already committed.
 * ADR 0011 is the argument; osquash has rejected three PRs that injected this directly.
 */
@Injectable()
export class SnsEventPublisher implements EventPublisher {
  private readonly sns: SNSClient;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    private readonly ids: IdFactory,
  ) {
    this.sns = new SNSClient({
      region: this.config.aws.region,
      endpoint: this.config.aws.endpointUrl,
    });
  }

  async publish<T extends EventType>(
    type: T,
    payload: PayloadOfType<T>,
    ctx: PublishContext,
  ): Promise<string> {
    const envelope = this.envelope(type, payload, ctx);
    await this.send(envelope);
    return envelope.id;
  }

  /**
   * SNS caps a batch at 10 entries, so the drain's page size and this chunk size are
   * related on purpose: a 100-row drain becomes ten batch calls, not a hundred.
   */
  async publishBatch(events: ReadonlyArray<PayzenoEvent>): Promise<string[]> {
    const topic = topicOf(event.type);
    await this.sns.send(
      new PublishCommand({
        TopicArn: this.topicArn(topic),
        Message: JSON.stringify(event),
        MessageAttributes: this.attributes(event),
      }),
    );
    this.logger.debug('bus.published', {
      event_id: event.id,
      type: event.type,
      topic,
      correlation_id: event.correlation_id,
    });
  }

  /**
   * Fanout is by `MessageAttributes.event_type`, not by body inspection — the
   * `payzeno-console-notifications` subscription filters `dispute.opened` off the payments
   * topic with a subscription filter policy on exactly this attribute.
   */
  private attributes(event: PayzenoEvent): Record<string, { DataType: string; StringValue: string }> {
    return {
      event_type: { DataType: 'String', StringValue: event.type },
      source: { DataType: 'String', StringValue: event.source },
      livemode: { DataType: 'String', StringValue: String(event.livemode) },
    };
  }

  private topicArn(topic: TopicName): string {
    switch (topic) {
      case 'payzeno-payments-events':
        return this.config.aws.snsPaymentsTopicArn;
      case 'payzeno-merchant-events':
        return this.config.aws.snsMerchantTopicArn;
      default:
        // payzeno-api never originates ledger or billing events. Reaching here means an
        // outbox row was written for an event this service does not own.
        throw new Error(`payzeno-api does not publish on topic "${topic}"`);
    }
  }

  private groupByTopic(
    events: ReadonlyArray<PayzenoEvent>,
  ): Array<{ topic: TopicName; events: PayzenoEvent[] }> {
    const buckets = new Map<TopicName, PayzenoEvent[]>();
    for (const event of events) {
      const topic = topicOf(event.type);
      const bucket = buckets.get(topic);
      if (bucket) {
        bucket.push(event);
      } else {
        buckets.set(topic, [event]);
      }
    }
    return [...buckets.entries()].map(([topic, grouped]) => ({ topic, events: grouped }));
  }

  private envelope<T extends EventType>(
    type: T,
    payload: PayloadOfType<T>,
    ctx: PublishContext,
  ): PayzenoEvent {
    const envelope: EventEnvelope<T, PayloadOfType<T>> = {
      id: this.ids.generate(ApiIdPrefix.EVENT),
      type,
      version: EVENT_SCHEMA_VERSIONS[type],
      occurred_at: ctx.occurredAt ?? this.clock.now().toISOString(),
      source: 'payzeno-api',
      correlation_id: ctx.correlationId,
      causation_id: ctx.causationId,
      merchant_id: ctx.merchantId,
      livemode: ctx.livemode,
      payload,
    };
    return envelope as unknown as PayzenoEvent;
  }
}
