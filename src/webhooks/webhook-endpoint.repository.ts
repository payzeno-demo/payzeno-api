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

  async findScopedById(merchantId: MerchantId, id: string): Promise<WebhookEndpointEntity | null> {
    return this.findOneBy({ merchantId, id } as never);
  }

  /** Delivery outcome bookkeeping. Kept here so the job never touches a query builder. */
  async recordSuccess(id: string, at: Date): Promise<void> {
    await this.update({ id } as never, {
      consecutiveFailureCount: 0,
      lastSuccessAt: at,
    });
  }

  async recordFailure(id: string): Promise<number> {
    await this.createQueryBuilder()
      .update(WebhookEndpointEntity)
      .set({ consecutiveFailureCount: () => 'consecutive_failure_count + 1' })
      .where('id = :id', { id })
      .execute();

    const row = await this.findOneBy({ id } as never);
    return row?.consecutiveFailureCount ?? 0;
  }

  /**
   * domain-model.md §10: no successful delivery for 72h AND at least 20 consecutive dead
   * events moves the endpoint to `disabled`. The merchant re-enables it from the console.
   */
  async findStale(
    olderThan: Date,
    minConsecutiveFailures: number,
    limit: number,
  ): Promise<WebhookEndpointEntity[]> {
    return this.createQueryBuilder('e')
      .where("e.status = 'enabled'")
      .andWhere('e.consecutive_failure_count >= :minConsecutiveFailures', {
        minConsecutiveFailures,
      })
      .andWhere('(e.last_success_at is null or e.last_success_at < :olderThan)', { olderThan })
      .limit(limit)
      .getMany();
  }

  async disable(id: string): Promise<void> {
    await this.update({ id } as never, { status: 'disabled' });
  }

  /** Endpoints whose rotation overlap has expired and whose previous secret can be dropped. */
  async findRotationsToFinalise(before: Date): Promise<WebhookEndpointEntity[]> {
    return this.find({
      where: { rotatedAt: LessThan(before) },
      take: 200,
    } as never);
  }
}
