/**
 * MerchantsService — L7, `extends BaseService<MerchantEntity>`.
 *
 * Two things here are load-bearing well beyond this file:
 *
 *  1. `update()` emits `merchant.updated` carrying the FULL mutable field set. That event is
 *     the only mechanism by which `merchant_projection.capture_at_settlement`, `reserve_bps`,
 *     `risk_tier` and `payout_schedule` can ever change in payzeno-ledger. Drop the emit and
 *     migration 0013's column can be added and never set — which makes arc INC's blast radius
 *     unreachable by any specified path.
 *  2. `changeStatus()` is a conditional UPDATE behind the state machine, not a read-then-write.
 *     Two staff operators clicking "suspend" and "reinstate" a second apart must not produce
 *     an active merchant with a suspension in the audit log.
 *
 * `findInternal` is the read `LedgerEventsConsumer` uses on the `settlement.duplicate_detected`
 * branch — it needs `capture_at_settlement` for a merchant it has only an id for, off the bus,
 * with no principal and no request scope. It returns null instead of throwing because a
 * duplicate detected against a merchant we have since closed is a log line, not a 404.
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  CreateMerchantRequest,
  ListQuery,
  Merchant,
  MerchantId,
  MerchantStatus,
  Paginated,
  UpdateMerchantRequest,
} from '@payzeno/contracts';

import { BaseService } from '../common/base/base.service';
import { MerchantNotFoundException } from '../common/errors/not-found.exceptions';
import { InvalidMerchantTransitionException } from '../common/errors/state.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { currentCorrelationId } from '../common/logging/request-context';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';

import { MerchantOnboardingService } from './merchant-onboarding.service';
import { MerchantStatusStateMachine } from './merchant-status.state-machine';
import { MerchantEntity } from './merchant.entity';
import { MerchantRepository, type MerchantPatch } from './merchant.repository';

/** Fields only a `staff_session` may change. A merchant-session PATCH carrying any is 403. */
export const STAFF_ONLY_MERCHANT_FIELDS: readonly (keyof UpdateMerchantRequest)[] = [
  'risk_tier',
  'reserve_bps',
  'reserve_hold_days',
  'payout_delay_days',
  'platform_fee_bps',
  'platform_fee_fixed_minor',
  'settlement_tolerance_minor',
  'capture_at_settlement',
];

@Injectable()
export class MerchantsService extends BaseService<MerchantEntity> {
  constructor(
    private readonly merchants: MerchantRepository,
    private readonly onboarding: MerchantOnboardingService,
    private readonly statuses: MerchantStatusStateMachine,
    private readonly transactions: TransactionManager,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(merchants, logger);
  }

  get entityName(): string {
    return 'merchant';
  }

  protected override notFound(id: string): MerchantNotFoundException {
    return new MerchantNotFoundException(id);
  }

  /**
   * `POST /v1/merchants`. Staff only — a merchant cannot create itself.
   *
   * The whole body of this method is one delegation, and that is the point: onboarding is a
   * multi-aggregate transaction with a cross-repo write in it, and keeping it in the
   * application service would put an HTTP call to payzeno-ledger inside a class whose other
   * methods are single-row updates. L6 exists for exactly this.
   */
  async create(request: CreateMerchantRequest, livemode: boolean, actor: string): Promise<Merchant> {
    const merchant = await this.onboarding.onboard(request, livemode, actor);
    return toMerchantResponse(merchant);
  }

  /** The row. `PayoutsService.create` and `ChargeCaptureService` both come through here. */
  async getById(merchantId: MerchantId): Promise<MerchantEntity> {
    const merchant = await this.merchants.findById(merchantId);
    if (!merchant) throw new MerchantNotFoundException(merchantId);
    return merchant;
  }

  async get(merchantId: MerchantId): Promise<Merchant> {
    return toMerchantResponse(await this.getById(merchantId));
  }

  /** Bus-side read. Null, not a throw — see the header. */
  async findInternal(merchantId: MerchantId): Promise<MerchantEntity | null> {
    return this.merchants.findById(merchantId);
  }

  /** Staff list. There is no merchant-scoped merchant list — a merchant sees exactly itself. */
  async listForStaff(query: ListQuery, status?: MerchantStatus): Promise<Paginated<Merchant>> {
    const page = await this.merchants.listForStaff(query, status);
    return {
      data: page.data.map(toMerchantResponse),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }

  /**
   * `PATCH /v1/merchants/:merchantId`.
   *
   * Chain: MerchantsController.update → here → TransactionManager.runInTransaction
   *        → MerchantRepository.applyPatch → OutboxEventPublisher.publish('merchant.updated')
   */
  async update(
    merchantId: MerchantId,
    request: UpdateMerchantRequest,
    actor: string,
  ): Promise<Merchant> {
    const before = await this.getById(merchantId);
    const merchant = await this.getById(merchantId);
    const updated = await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.merchants.transitionStatus(merchantId, merchant.status, next, manager);

      if (affected === 0) {
        throw new InvalidMerchantTransitionException(merchant.status, event);
      }

      await this.events.publish(
        'merchant.status_changed',
        {
          merchant_id: merchantId,
          previous_status: merchant.status,
          status: next,
          reason,
          changed_by: actor,
          changed_at: this.clock.nowIso(),
        },
        {
          merchantId,
          correlationId: currentCorrelationId(),
          causationId: null,
          livemode: merchant.livemode,
          occurredAt: this.clock.nowIso(),
        },
      );

      const row = await this.merchants.findById(merchantId, manager);
      if (!row) throw new MerchantNotFoundException(merchantId);
      return row;
    });

    this.logger.info('merchant.status_changed', {
      merchant_id: merchantId,
      from: merchant.status,
      to: next,
      actor,
    });

    return toMerchantResponse(updated);
  }

  /** `RiskEvaluationService` restricts through here so the event and the audit row still happen. */
  async restrictForRisk(merchantId: MerchantId, disputeRateBps: number): Promise<Merchant> {
    return this.changeStatus(
      merchantId,
      'restricted',
      `trailing-30d dispute rate ${disputeRateBps} bps exceeds 100 bps`,
      'system:risk_evaluation',
    );
  }
}

/** Entity → wire. The single mapping; nothing else builds a `Merchant`. */
export function toMerchantResponse(entity: MerchantEntity): Merchant {
  return {
    id: entity.id,
    object: 'merchant',
    legal_name: entity.legalName,
    display_name: entity.displayName,
    country: entity.country,
    default_currency: entity.defaultCurrency,
    status: entity.status,
    mcc: entity.mcc,
    risk_tier: entity.riskTier,
    payout_schedule: entity.payoutSchedule,
    reserve_bps: entity.reserveBps,
    reserve_hold_days: entity.reserveHoldDays,
    pricing_model: entity.pricingModel,
    platform_fee_bps: entity.platformFeeBps,
    platform_fee_fixed_minor: Number(entity.platformFeeFixedMinor),
    payout_delay_days: entity.payoutDelayDays,
    settlement_tolerance_minor: Number(entity.settlementToleranceMinor),
    capture_at_settlement: entity.captureAtSettlement,
    livemode: entity.livemode,
    metadata: entity.metadata ?? {},
    created_at: entity.toIsoCreatedAt(),
    updated_at: entity.toIsoUpdatedAt(),
  };
}

/** Wire → column names. Only the keys actually present are written. */
function toPatch(request: UpdateMerchantRequest): MerchantPatch {
  const patch: MerchantPatch = {};

  if (request.display_name !== undefined) patch.displayName = request.display_name;
  if (request.payout_schedule !== undefined) patch.payoutSchedule = request.payout_schedule;
  if (request.statement_descriptor !== undefined) patch.statementDescriptor = request.statement_descriptor;
  if (request.risk_tier !== undefined) patch.riskTier = request.risk_tier;
  if (request.reserve_bps !== undefined) patch.reserveBps = request.reserve_bps;
  if (request.reserve_hold_days !== undefined) patch.reserveHoldDays = request.reserve_hold_days;
  if (request.payout_delay_days !== undefined) patch.payoutDelayDays = request.payout_delay_days;
  if (request.platform_fee_bps !== undefined) patch.platformFeeBps = request.platform_fee_bps;
  if (request.platform_fee_fixed_minor !== undefined) {
    patch.platformFeeFixedMinor = request.platform_fee_fixed_minor;
  }
  if (request.settlement_tolerance_minor !== undefined) {
    patch.settlementToleranceMinor = request.settlement_tolerance_minor;
  }
  if (request.capture_at_settlement !== undefined) {
    patch.captureAtSettlement = request.capture_at_settlement;
  }
  if (request.metadata !== undefined) patch.metadata = request.metadata;

  return patch;
}
