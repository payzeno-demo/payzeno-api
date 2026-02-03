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
const VISIBILITY_TIMEOUT_SECONDS = 60;

/**
 * The base every payzeno-api queue consumer extends.
 *
 * Delivery is at-least-once and ordering is not guaranteed — both are stated in
 * @payzeno/contracts/events and neither is negotiable. The consequences are baked in here so
 * no individual consumer has to remember them:
 *
 *  - dedupe is an INSERT-FIRST claim on `processed_event`, in the SAME transaction as the
 *    handler's side effects (ADR 0011);
 *  - an unknown `(type, version)` goes to the DLQ rather than being guessed at;
 *  - a handler that throws does NOT delete the message, so SQS redelivers it.
 *
 * See docs/adr/0009-event-consumer-wiring.md for why consumers resolve their collaborators
 * through `ModuleRef` in `onModuleInit` instead of `EventsModule` importing feature modules.
 */
export abstract class BaseEventConsumer {
  /** The SQS queue this consumer long-polls. Comes from `ApiConfig`, never from env. */
  abstract readonly queueUrl: string;

  /** Stable identity written into `processed_event.consumer`. Never the class instance. */
  abstract readonly consumerName: string;

  /** Everything else on the queue is acknowledged and dropped. */
  abstract readonly handledTypes: ReadonlySet<EventType>;

  /** Runs inside the claim transaction. `tx` is the ONLY manager it may write through. */
  abstract handle(event: PayzenoEvent, tx: EntityManager): Promise<void>;

  protected constructor(
    protected readonly sqs: SQSClient,
    protected readonly transactions: TransactionManager,
    protected readonly processedEvents: ProcessedEventRepository,
    protected readonly logger: PayzenoLogger,
  ) {}

  /**
   * The long-poll loop. Started by `EventsModule.onApplicationBootstrap` with an
   * AbortSignal that Nest trips on shutdown, so an in-flight message finishes before the
   * process exits.
   */
  async run(signal: AbortSignal): Promise<void> {
    this.logger.info('consumer.started', {
      consumer: this.consumerName,
