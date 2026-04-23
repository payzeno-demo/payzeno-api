import { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { CommonModule } from '../common/common.module';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { BaseEventConsumer } from './consumer';
import { DeadLetterConsumer } from './dead-letter.consumer';
import { EventOutbox } from './event-outbox.entity';
import { EventOutboxRepository } from './event-outbox.repository';
import { InvoiceProjectionConsumer } from './invoice-projection.consumer';
import { LedgerEventsConsumer } from './ledger-events.consumer';
import { OutboxEventPublisher } from './outbox-event.publisher';
import { ProcessedEvent } from './processed-event.entity';
import { ProcessedEventRepository } from './processed-event.repository';
import { BUS_PUBLISHER, EVENT_PUBLISHER } from './publisher';
import { SettlementCompletion } from './settlement-completion.entity';
import { SnsEventPublisher } from './sns-event.publisher';
import { WebhookFanoutConsumer } from './webhook-fanout.consumer';

/**
 * The bus module.
 *
 * It imports `CommonModule` and nothing else — deliberately. Consumers need services that
 * live in feature modules, and if `EventsModule` imported `PaymentsModule` (which imports
 * `EventsModule` for the publisher) Nest would resolve a cycle at boot and one of the two
 * would get an undefined provider. Instead each consumer resolves its collaborators with
 * `ModuleRef.get(..., { strict: false })` in `onModuleInit`, once the whole graph exists.
 *
 * ystackoverflow asked about this in review in month 11; the answer is
 * docs/adr/0009-event-consumer-wiring.md. — dhotfix
 */
@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([EventOutbox, ProcessedEvent, SettlementCompletion]),
  ],
  providers: [
    {
      provide: SQSClient,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        new SQSClient({ region: config.aws.region, endpoint: config.aws.endpointUrl }),
    },
    EventOutboxRepository,
    ProcessedEventRepository,
    SnsEventPublisher,
    OutboxEventPublisher,
    { provide: EVENT_PUBLISHER, useExisting: OutboxEventPublisher },
    { provide: BUS_PUBLISHER, useExisting: SnsEventPublisher },
    LedgerEventsConsumer,
    WebhookFanoutConsumer,
    InvoiceProjectionConsumer,
    DeadLetterConsumer,
  ],
  exports: [
    SQSClient,
    EVENT_PUBLISHER,
    BUS_PUBLISHER,
    EventOutboxRepository,
    ProcessedEventRepository,
    SnsEventPublisher,
    OutboxEventPublisher,
    TypeOrmModule,
  ],
})
export class EventsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private readonly running: Array<Promise<void>> = [];

  constructor(
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    private readonly ledgerEvents: LedgerEventsConsumer,
    private readonly invoiceProjection: InvoiceProjectionConsumer,
    private readonly deadLetter: DeadLetterConsumer,
  ) {}

  /**
   * Long-poll loops start after the whole application graph is up, so a consumer can never
   * receive a message before the services it resolved in `onModuleInit` are usable.
   */
  onApplicationBootstrap(): void {
    const consumers: BaseEventConsumer[] = [
      this.ledgerEvents,
      this.webhookFanout,
      this.invoiceProjection,
      this.deadLetter,
    ];

    for (const consumer of consumers) {
      this.running.push(
        consumer.run(this.abort.signal).catch((err) => {
          this.logger.error('consumer.crashed', err, { consumer: consumer.consumerName });
        }),
      );
    }

    this.logger.info('events.consumers_started', { count: consumers.length });
  }

  /** Trip the signal and let in-flight messages finish before the process exits. */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.running);
    this.logger.info('events.consumers_stopped', { signal: signal ?? 'unknown' });
  }
}
