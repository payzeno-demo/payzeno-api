import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { EntityManager } from 'typeorm';
import {
  EVENT_SCHEMA_VERSIONS,
  type EventType,
  type PayzenoEvent,
} from '@payzeno/contracts/events';
import type { PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { ProcessedEventRepository } from './processed-event.repository';

/**
 * SQS long-poll parameters. 20s is the maximum the API allows and is what makes an idle
 * consumer cost one request every twenty seconds instead of fifty a second.
 */
const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 10;
