/**
 * L1. The only code that writes `merchant_onboarding` and `kyc_document`.
 *
 * Every state change on onboarding happens under `lockForMerchant` (SELECT … FOR UPDATE inside
 * the caller's transaction): a merchant pressing "submit" while a reviewer presses "approve" is
 * exactly the race this table exists to decide, and the loser must re-read the winner's state,
 * not overwrite it.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';

import type { KycDocumentType, MerchantId } from '@payzeno/contracts';

import { PayzenoRepository, toInsertRow } from '../common/persistence/payzeno.repository';

import { KycDocumentEntity } from './kyc-document.entity';
import { OnboardingEntity } from './onboarding.entity';

@Injectable()
export class OnboardingRepository extends PayzenoRepository<OnboardingEntity> {
  constructor(dataSource: DataSource) {
    super(OnboardingEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'merchant_onboarding';
  }

  findByMerchant(merchantId: MerchantId, manager?: EntityManager): Promise<OnboardingEntity | null> {
    const repo = manager ? manager.getRepository(OnboardingEntity) : this;
    return repo.findOne({ where: { merchantId } });
  }

  findManyByMerchants(merchantIds: readonly MerchantId[]): Promise<OnboardingEntity[]> {
    if (merchantIds.length === 0) return Promise.resolve([]);
    return this.find({ where: { merchantId: In([...merchantIds]) } });
  }

  /** `ON CONFLICT DO NOTHING` on `uq_merchant_onboarding_merchant`: two first reads race to one row. */
  async insertIfMissing(row: OnboardingEntity, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(OnboardingEntity) : this;
    await repo.createQueryBuilder().insert().into(OnboardingEntity).values(toInsertRow(row)).orIgnore().execute();
  }

  lockForMerchant(merchantId: MerchantId, manager: EntityManager): Promise<OnboardingEntity | null> {
    return manager
      .getRepository(OnboardingEntity)
      .createQueryBuilder('merchant_onboarding')
      .setLock('pessimistic_write')
      .where('merchant_onboarding.merchant_id = :merchantId', { merchantId })
      .getOne();
  }

  /** Writes back the mutable columns of a row read under `lockForMerchant`. */
  async saveLocked(row: OnboardingEntity, manager: EntityManager): Promise<void> {
    await manager.getRepository(OnboardingEntity).update(
      { id: row.id },
      {
        state: row.state,
        businessProfile: { ...row.businessProfile },
        representative: { ...row.representative },
        staffMessage: row.staffMessage,
        submittedAt: row.submittedAt,
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy,
      },
    );
  }

  // -- kyc_document ------------------------------------------------------------------------------

  async appendDocument(row: KycDocumentEntity, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(KycDocumentEntity) : this.manager.getRepository(KycDocumentEntity);
    await repo.insert(toInsertRow(row));
  }

  listDocuments(merchantId: MerchantId, manager?: EntityManager): Promise<KycDocumentEntity[]> {
    const em = manager ?? this.manager;
    return em.getRepository(KycDocumentEntity).find({ where: { merchantId }, order: { createdAt: 'ASC' } });
  }

  findDocument(merchantId: MerchantId, documentId: string): Promise<KycDocumentEntity | null> {
    return this.manager.getRepository(KycDocumentEntity).findOne({ where: { id: documentId, merchantId } });
  }

  async documentTypes(merchantId: MerchantId, manager?: EntityManager): Promise<Set<KycDocumentType>> {
    const rows = await this.listDocuments(merchantId, manager);
    return new Set(rows.map((row) => row.type));
  }
}
