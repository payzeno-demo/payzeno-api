/**
 * L1. The only code that writes `merchant`.
 *
 * `scopeColumn` is overridden to `id`: the merchant is its own tenant, so `findScoped` and
 * `updateScoped` narrow on `merchant.id`, not on a `merchant_id` column that does not exist.
 * That override is the reason `PayzenoRepository.scopeColumn` is a getter and not a constant.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, type FindOptionsWhere } from 'typeorm';

import type { MerchantId, MerchantStatus, Paginated, RiskTier } from '@payzeno/contracts';

import { resolveListQuery, type ResolvedListQuery } from '../common/pagination/list-query.dto';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';

import { MerchantEntity } from './merchant.entity';

/** The mutable field set of `PATCH /v1/merchants/:merchantId`. Staff-only fields included. */
export interface MerchantPatch {
  displayName?: string;
  payoutSchedule?: string;
  statementDescriptor?: string | null;
  riskTier?: RiskTier;
  reserveBps?: number;
  reserveHoldDays?: number;
  payoutDelayDays?: number;
  platformFeeBps?: number;
  platformFeeFixedMinor?: number;
  settlementToleranceMinor?: number;
  captureAtSettlement?: boolean;
  metadata?: Record<string, string>;
}

@Injectable()
export class MerchantRepository extends PayzenoRepository<MerchantEntity> {
  constructor(dataSource: DataSource) {
    super(MerchantEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'merchant';
  }

  /** The merchant is its own tenant. See the header. */
  protected override get scopeColumn(): string {
    return 'id';
  }

  findById(merchantId: MerchantId, manager?: EntityManager): Promise<MerchantEntity | null> {
    const repo = manager ? manager.getRepository(MerchantEntity) : this;
    return repo.findOne({ where: { id: merchantId } });
  }

  /**
   * Case-insensitive on the legal name because `uq_merchant_legal_name_country` is not, and
   * onboarding the same company twice with different capitalisation is the duplicate we
   * actually see. `MerchantOnboardingService` calls this before it inserts.
   */
  findByLegalName(legalName: string, country: string): Promise<MerchantEntity | null> {
    return this.createQueryBuilder('merchant')
      .where('lower(merchant.legal_name) = lower(:legalName)', { legalName })
      .andWhere('merchant.country = :country', { country })
      .getOne();
  }

  findManyByIds(ids: readonly MerchantId[]): Promise<MerchantEntity[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.find({ where: { id: In([...ids]) } as FindOptionsWhere<MerchantEntity> });
  }

  /** Staff-facing list. Not merchant-scoped — there is no tenant to scope a platform list to. */
  async listForStaff(
    query: ResolvedListQuery | { limit?: number; cursor?: string },
    status?: MerchantStatus,
  ): Promise<Paginated<MerchantEntity>> {
    const resolved = 'createdAfter' in query ? query : resolveListQuery(query);
    let qb = this.createQueryBuilder('merchant');

    if (status) {
      qb = qb.where('merchant.status = :status', { status });
    }

    const rows = await qb
      .orderBy('merchant.created_at', 'DESC')
      .addOrderBy('merchant.id', 'DESC')
      .take(resolved.limit + 1)
      .getMany();

    const hasMore = rows.length > resolved.limit;
    const data = hasMore ? rows.slice(0, resolved.limit) : rows;

    return { data, has_more: hasMore, next_cursor: null };
  }

  async applyPatch(
    merchantId: MerchantId,
    patch: MerchantPatch,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager ? manager.getRepository(MerchantEntity) : this;
    const repo = manager ? manager.getRepository(MerchantEntity) : this;
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ status: to })
      .where('id = :merchantId', { merchantId })
      .andWhere('status = :from', { from })
      .execute();

    return result.affected ?? 0;
  }

  /** `RiskEvaluationJob` walks these. Only active merchants can be restricted for risk. */
  listActiveLive(limit: number, afterId: string | null): Promise<MerchantEntity[]> {
  }
}
