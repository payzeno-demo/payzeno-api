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
      queue_url: this.queueUrl,
      handled_types: [...this.handledTypes].join(','),
    });

    while (!signal.aborted) {
      let messages: Message[] = [];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: MAX_MESSAGES,
            WaitTimeSeconds: WAIT_TIME_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageAttributeNames: ['All'],
          }),
        );
        messages = response.Messages ?? [];
      } catch (err) {
        this.logger.error('consumer.receive_failed', err, { consumer: this.consumerName });
        await this.pause(2000);
        continue;
      }

      for (const message of messages) {
        if (signal.aborted) {
          break;
        }
        await this.processMessage(message);
      }
    }

    this.logger.info('consumer.stopped', { consumer: this.consumerName });
  }

  /**
   * One message, end to end. Deletes the message on success or on a deliberate drop;
   * leaves it on the queue on failure so SQS's own redelivery + DLQ policy takes over.
   */
  async processMessage(message: Message): Promise<void> {
    const event = this.parse(message);
    if (!event) {
      // Unparseable body. Nothing downstream can help; let the redrive policy DLQ it.
      this.logger.error('consumer.unparseable_message', null, {
        consumer: this.consumerName,
        message_id: message.MessageId ?? 'unknown',
      });
      return;
    }

    if (!this.handledTypes.has(event.type)) {
      await this.acknowledge(message);
      return;
    }

    if (!this.isKnownVersion(event)) {
      // Route to the DLQ rather than guessing at a payload shape we have never seen.
      this.logger.warn('consumer.unknown_schema_version', {
        consumer: this.consumerName,
        event_id: event.id,
        type: event.type,
        version: event.version,
        known_version: EVENT_SCHEMA_VERSIONS[event.type],
      });
      return;
    }

    const started = Date.now();
    try {
      const handled = await this.transactions.runInTransaction(async (tx) => {
        const claimed = await this.claimEvent(event.id, tx);
        if (!claimed) {
          return false;
        }
        await this.handle(event, tx);
        return true;
      });

      await this.acknowledge(message);
      this.logger.info(handled ? 'consumer.handled' : 'consumer.duplicate_skipped', {
        consumer: this.consumerName,
        event_id: event.id,
        type: event.type,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      this.logger.error('consumer.handler_failed', err, {
        consumer: this.consumerName,
        event_id: event.id,
        type: event.type,
        duration_ms: Date.now() - started,
      });
      // Deliberately no delete: SQS redelivers, and the queue's redrive policy DLQs it.
    }
  }

  /**
   * Dedupe. INSERT-FIRST, in the same transaction as the handler's side effects:
   *
   *   INSERT INTO processed_event (event_id, consumer)
   *   VALUES (...) ON CONFLICT DO NOTHING RETURNING event_id
   *
   * Returns false when the row already existed — the handler is then skipped entirely.
   * There is deliberately NO `alreadyProcessed` / `markProcessed` pair; check-then-act is
   * the shape of PAY-2041 and ADR 0011 forbids it in the money path. This is the money path.
   */
  protected async claimEvent(eventId: string, tx: EntityManager): Promise<boolean> {
    return this.processedEvents.claim(tx, eventId, this.consumerName);
  }

  /** SNS-to-SQS wraps the message; a raw-delivery queue does not. Tolerate both. */
  protected parse(message: Message): PayzenoEvent | null {
