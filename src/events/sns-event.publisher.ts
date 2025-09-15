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
  }
}
