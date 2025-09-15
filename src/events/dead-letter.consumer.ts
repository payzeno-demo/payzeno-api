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

}
