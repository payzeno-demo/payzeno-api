/**
 * L1. The only writer of `payment_intent`.
 *
 * `client_secret` never leaves this file in a WHERE clause built by string concatenation, and
 * `findByClientSecret` is the only lookup that does not carry a merchant id — `ClientSecretGuard`
 * is what turns the secret into a scoped principal, so the scope check happens above.
 */

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, type FindOptionsWhere } from 'typeorm';
import type {
  CancellationReason,
  ChargeId,
  MerchantId,
  Paginated,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
} from '@payzeno/contracts';

import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { PaymentIntentEntity } from './payment-intent.entity';

@Injectable()
export class PaymentIntentRepository extends PayzenoRepository<PaymentIntentEntity> {
  constructor(dataSource: DataSource) {
    super(PaymentIntentEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'payment_intent';
  }

  /**
   * The only INSERT into `payment_intent`. Takes the manager so `PaymentIntentsService.create`
   * can write the row and (when `confirm=true`) run the confirm flow's first transition
   * without a window in which the intent exists but is unconfirmable.
   */
  async insertIntent(
    manager: EntityManager,
    row: Partial<PaymentIntentEntity> & { id: PaymentIntentId },
  ): Promise<PaymentIntentEntity> {
    const entity = manager.create(PaymentIntentEntity, row);
    return manager.save(PaymentIntentEntity, entity);
  }

}
