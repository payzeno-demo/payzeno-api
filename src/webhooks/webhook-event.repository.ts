import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { MerchantId, PublicEventType, WebhookEventStatus } from '@payzeno/contracts';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { WebhookEventEntity } from './webhook-event.entity';

@Injectable()
export class WebhookEventRepository extends PayzenoRepository<WebhookEventEntity> {
  constructor(dataSource: DataSource) {
    super(WebhookEventEntity, dataSource.createEntityManager());
  }

  /**
   * The only insert path for this table, called from `WebhookFanoutConsumer` inside the
   * claim transaction.
   *
   * ON CONFLICT DO NOTHING against `uq_webhook_event_source (endpoint_id, source_event_id)`.
   * The bus is at-least-once: without this key a redelivered `payout.failed` sends the
   * merchant a second webhook, and merchants build accounting on these.
   *
   * Returns the number of rows that were actually new.
   */
  async insertIgnoringSourceConflict(
    tx: EntityManager,
    rows: readonly WebhookEventEntity[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
