import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { EVENT_TYPES, type EventType, type PayzenoEvent } from '@payzeno/contracts/events';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { BaseEventConsumer } from './consumer';
import { ProcessedEventRepository } from './processed-event.repository';

/** How many times we will put the same envelope back on its origin queue before parking it. */
const MAX_REDRIVES = 3;

/**
 * Queue `payzeno-dlq-monitor`. Handles everything and does almost nothing.
 *
 * Its whole job is to make a poisoned message visible and, when the failure looked
 * transient, to put it back where it came from. It deliberately does not interpret payloads
 * — if it did, it would become a second implementation of every handler, and the one thing
 * worse than a stuck DLQ is a DLQ that quietly half-applies events.
 *
 * `processed_event`'s PK is `(event_id, consumer)` precisely so this consumer can claim an
 * event that `LedgerEventsConsumer` already processed. Before migration 26 it collided on
 * every redrive and could never mark anything processed.
 */
@Injectable()
export class DeadLetterConsumer extends BaseEventConsumer {
  readonly queueUrl: string;
  readonly consumerName = 'dead-letter';

  /** Everything. The DLQ has no vocabulary of its own. */
  readonly handledTypes = new Set<EventType>(EVENT_TYPES);

  /** In-memory, per-task. A restart resets it — that is acceptable and documented. */
  private readonly redriveCounts = new Map<string, number>();

  constructor(
    sqs: SQSClient,
    transactions: TransactionManager,
    processedEvents: ProcessedEventRepository,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    super(sqs, transactions, processedEvents, logger);
    this.queueUrl = this.config.aws.sqsDlqUrl;
  }

  /**
   * The claim is the side effect. Recording that we have seen this envelope on the DLQ is
   * what makes `GET /internal/v1/…` triage and the runbook's "has it been redriven?"
   * question answerable.
   */
  async handle(event: PayzenoEvent, _tx: EntityManager): Promise<void> {
    this.logger.error('dlq.received', null, {
      event_id: event.id,
      type: event.type,
      source: event.source,
      merchant_id: event.merchant_id,
      correlation_id: event.correlation_id,
      occurred_at: event.occurred_at,
    });
  }

  /**
   * Override the base loop: the DLQ is polled slowly and every message is re-published to
   * its origin queue rather than merely acknowledged. `runOnce` exists so the redrive can
   * also be triggered by hand from the runbook without waiting for the poll.
   */
  async runOnce(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        MessageAttributeNames: ['All'],
      }),
    );

    const messages = response.Messages ?? [];
    let redriven = 0;

    for (const message of messages) {
      const event = this.parse(message);
      if (!event) {
        this.logger.error('dlq.unparseable', null, { message_id: message.MessageId ?? '?' });
        await this.acknowledge(message);
        continue;
      }

      await this.processMessage(message);

      if (await this.redrive(event, message)) {
        redriven += 1;
      }
    }

    return redriven;
  }

  /**
   * Put the envelope back on the queue it failed on. Origin is taken from the message
   * attribute the redrive policy stamps; without it we cannot know where to send it and the
   * message stays parked for a human.
   */
  private async redrive(event: PayzenoEvent, message: Message): Promise<boolean> {
    const origin = message.MessageAttributes?.origin_queue_url?.StringValue;
    if (!origin) {
      this.logger.warn('dlq.parked_no_origin', { event_id: event.id, type: event.type });
      return false;
    }

    const attempts = (this.redriveCounts.get(event.id) ?? 0) + 1;
    this.redriveCounts.set(event.id, attempts);

    if (attempts > MAX_REDRIVES) {
      this.logger.error('dlq.parked_redrive_exhausted', null, {
        event_id: event.id,
        type: event.type,
        attempts,
      });
      return false;
    }

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: origin,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          event_type: { DataType: 'String', StringValue: event.type },
          redrive_attempt: { DataType: 'Number', StringValue: String(attempts) },
        },
      }),
    );

    if (message.ReceiptHandle) {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }

    this.logger.info('dlq.redriven', {
      event_id: event.id,
      type: event.type,
      origin_queue_url: origin,
      attempt: attempts,
    });
    return true;
  }
}
