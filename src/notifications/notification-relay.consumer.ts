/**
 * NotificationRelayConsumer — queue `payzeno-console-notifications`.
 *
 * The console is a socket client, not a queue consumer (api-surface.md §14). This is the
 * class that makes that queue's LISTENS_ON edge attach to something real: it claims the
 * event like every other consumer, turns it into a `Notification`, and hands it to
 * `NotificationsGateway.push()`.
 *
 * The queue subscribes to two topics — `dispute.opened` is on the payments topic while
 * `payout.failed` and `settlement.completed` are on the ledger topic — so this consumer sees
 * envelopes from two producers and must not assume a `source`.
 *
 * A push that reaches zero sockets is the normal case, not a failure: most merchants do not
 * have the console open at 04:00 when the payout file fails. The claim still happens, so a
 * redelivery does not double-notify the one merchant who did.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { type EventType, type PayzenoEvent } from '@payzeno/contracts/events';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { BaseEventConsumer } from '../events/consumer';
import { ProcessedEventRepository } from '../events/processed-event.repository';

import { NotificationsGateway } from './notifications.gateway';
import { RELAYED_EVENT_TYPES, toNotification } from './notification.types';

@Injectable()
export class NotificationRelayConsumer extends BaseEventConsumer {
  readonly queueUrl: string;
  readonly consumerName = 'notification-relay';
  readonly handledTypes = new Set<EventType>(RELAYED_EVENT_TYPES);

  constructor(
    sqs: SQSClient,
    transactions: TransactionManager,
    processedEvents: ProcessedEventRepository,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly gateway: NotificationsGateway,
  ) {
    super(sqs, transactions, processedEvents, logger);
    this.queueUrl = this.config.aws.sqsConsoleNotificationsUrl;
  }

  /**
   * `tx` is unused on purpose and that is worth a sentence: this consumer has no persistent
   * side effect, so the only thing the transaction carries is the `processed_event` claim.
   * Keeping the push inside it means a socket write that throws rolls the claim back and the
   * message is redelivered — which is what we want, because the alternative is a merchant
   * who never learns their payout failed.
   */
  async handle(event: PayzenoEvent, tx: EntityManager): Promise<void> {
    void tx;

    const notification = toNotification(event);

    if (!notification) {
      // A batch-level `settlement.completed` has no tenant on the envelope. There is no
      // socket to route it to; the console reads settlements over REST instead.
      this.logger.debug('notification.skipped_untenanted', {
        event_id: event.id,
        type: event.type,
      });
      return;
    }

    const delivered = this.gateway.push(notification);

    this.logger.info('notification.relayed', {
      event_id: event.id,
      type: event.type,
      merchant_id: notification.merchant_id,
      severity: notification.severity,
      livemode: notification.livemode,
      sockets: delivered,
    });
  }
}
