/**
 * MerchantScopedEntity — `merchant_id` + `livemode` in one place.
 *
 * `livemode` is not a convenience column. Test-mode and live-mode data never share a row
 * (domain-model.md §11.5): it is part of every merchant-scoped unique index, part of the
 * `idempotency_record` primary key, and every consumer copies `EventEnvelope.livemode` onto
 * the row it writes. Without it, test payments post into the same chart of accounts as live
 * money and are payable to a real bank account.
 *
 * Extended by: Merchant (self-scoped), MerchantUser, ApiKeyEntity, BankAccount, PaymentIntent,
 * Charge, Refund, Dispute, WebhookEndpointEntity, WebhookEventEntity, AuditLog, SupportTask,
 * InvoiceProjection, IdempotencyRecord.
 */
import { Column, Index } from 'typeorm';

import type { MerchantId } from '@payzeno/contracts';

import { BaseEntity } from './base.entity';

export abstract class MerchantScopedEntity extends BaseEntity {
  @Index()
  @Column({ type: 'text', name: 'merchant_id' })
  merchantId!: MerchantId;

  @Column({ type: 'boolean', name: 'livemode' })
  livemode!: boolean;

  /**
   * The one predicate MerchantScopeGuard and PayzenoRepository.findScoped both use, so a
   * cross-tenant read and a cross-mode read fail the same way.
   */
  belongsTo(merchantId: MerchantId, livemode: boolean): boolean {
    return this.merchantId === merchantId && this.livemode === livemode;
  }
}

/** The scope tuple, passed down through the repository layer as one value. */
export interface MerchantScope {
  merchantId: MerchantId;
  livemode: boolean;
}

export function scopeOf(entity: MerchantScopedEntity): MerchantScope {
  return { merchantId: entity.merchantId, livemode: entity.livemode };
}
