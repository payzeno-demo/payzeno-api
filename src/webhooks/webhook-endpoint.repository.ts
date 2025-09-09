import { Injectable } from '@nestjs/common';
import { DataSource, LessThan } from 'typeorm';
import type { MerchantId, PublicEventType } from '@payzeno/contracts';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { WebhookEndpointEntity } from './webhook-endpoint.entity';

@Injectable()
export class WebhookEndpointRepository extends PayzenoRepository<WebhookEndpointEntity> {
  constructor(dataSource: DataSource) {
    super(WebhookEndpointEntity, dataSource.createEntityManager());
  }

  /**
   * The fanout lookup. `enabled_events` is a text[] so this is a containment test, not a
   * join — the whole point of storing the vocabulary on the row.
   */
  async findEnabledFor(
    merchantId: MerchantId,
    type: PublicEventType,
    livemode: boolean,
  ): Promise<WebhookEndpointEntity[]> {
    return this.createQueryBuilder('e')
      .where('e.merchant_id = :merchantId', { merchantId })
      .andWhere('e.livemode = :livemode', { livemode })
      .andWhere("e.status = 'enabled'")
      .andWhere('e.enabled_events @> ARRAY[:type]::text[]', { type })
      .orderBy('e.created_at', 'ASC')
      .getMany();
  }

  /** Endpoints whose rotation overlap has expired and whose previous secret can be dropped. */
  async findRotationsToFinalise(before: Date): Promise<WebhookEndpointEntity[]> {
    return this.find({
      where: { rotatedAt: LessThan(before) },
      take: 200,
    } as never);
  }
}
