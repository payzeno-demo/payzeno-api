/**
 * PaymentMethodsService — L7. Saved cards. RFC platform-v2 §5.
 *
 * Saving a card is two steps on purpose: `resolve` asks the vault what a `pmt_` token is (a
 * network call, outside any transaction), and `attach` writes the row inside the caller's
 * transaction — checkout saves the card in the same commit that completes the session, so a
 * session is never `complete` with the card it promised to save missing.
 *
 * The vault resolves a token as often as it is asked (no single-use tokens in this vault), which
 * is what makes a `pmt_` token reusable for one-click payments and off-session renewals.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CustomerId, PaymentMethodId } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ValidationException } from '../common/errors/api.exception';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { VaultClient } from '../payments/vault/vault.client';
import type { TokenResolution } from '../payments/vault/vault.types';

import { PAYMENT_METHOD_ID_PREFIX, PaymentMethodEntity } from './payment-method.entity';
import { PaymentMethodRepository } from './payment-method.repository';

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly methods: PaymentMethodRepository,
    private readonly vault: VaultClient,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** The vault's answer for a token: card summary and fingerprint. Throws 404/422 from the vault. */
  resolve(token: string): Promise<TokenResolution> {
    if (!token.startsWith('pmt_')) {
      throw new ValidationException('Only card tokens can be saved', [
        { path: 'payment_method_token', code: 'invalid_token', message: 'expected a pmt_ token' },
      ]);
    }
    return this.vault.resolve(token);
  }

  /**
   * Saves a resolved card to a customer, or returns the card already saved with the same
   * fingerprint. Runs in the caller's transaction.
   */
  async attach(
    manager: EntityManager,
    scope: MerchantScope,
    customerId: CustomerId,
    resolution: TokenResolution,
  ): Promise<PaymentMethodEntity> {
    const existing = await this.methods.findAttachedByFingerprint(manager, customerId, resolution.fingerprint);
    if (existing) {
      return existing;
    }

    const now = this.clock.now();
    const row = new PaymentMethodEntity();
    row.id = this.ids.opaque(PAYMENT_METHOD_ID_PREFIX);
    row.merchantId = scope.merchantId;
    row.livemode = scope.livemode;
    row.customerId = customerId;
    row.vaultToken = resolution.token;
    row.fingerprint = resolution.fingerprint;
    row.cardBrand = resolution.card.brand;
    row.cardLastFour = resolution.card.last_four;
    row.cardExpMonth = resolution.card.exp_month;
    row.cardExpYear = resolution.card.exp_year;
    row.cardCountry = resolution.card.country;
    row.cardFunding = resolution.card.funding;
    row.detachedAt = null;
    row.createdAt = now;
    row.updatedAt = now;

    await this.methods.insertPaymentMethod(manager, row);
    this.logger.info('payment_method_attached', {
      payment_method_id: row.id,
      customer_id: customerId,
      merchant_id: scope.merchantId,
      brand: row.cardBrand,
    });
    return row;
  }

  /**
   * A saved card a payment may use: attached, in scope, and the customer's own. Anything else
   * is the same 404 — a `pm_` id of another customer must not be distinguishable from none.
   */
  async getUsable(scope: MerchantScope, customerId: CustomerId | null, id: PaymentMethodId): Promise<PaymentMethodEntity> {
    const row = await this.methods.findAttached(scope, id);
    if (!row || (customerId !== null && row.customerId !== customerId)) {
      throw new ResourceNotFoundException('payment_method', id);
    }
    return row;
  }

  /** Like `getUsable`, but null instead of a 404 — the renewal job's read. */
  findUsable(scope: MerchantScope, id: PaymentMethodId): Promise<PaymentMethodEntity | null> {
    return this.methods.findAttached(scope, id);
  }

  list(scope: MerchantScope, customerId: CustomerId): Promise<PaymentMethodEntity[]> {
    return this.methods.listAttached(scope, customerId);
  }

  /**
   * Soft-detaches in the caller's transaction. Deleting the token at the vault happens after the
   * commit, best effort: a token that outlives its card row is the PCI retention job's to sweep,
   * and a failed vault call must not resurrect a card the merchant removed.
   */
  async detach(manager: EntityManager, scope: MerchantScope, customerId: CustomerId, id: PaymentMethodId): Promise<PaymentMethodEntity> {
    const row = await this.getUsable(scope, customerId, id);
    await this.methods.markDetached(manager, row.id, this.clock.now());
    row.detachedAt = this.clock.now();
    return row;
  }

  async forgetToken(row: PaymentMethodEntity): Promise<void> {
    try {
      await this.vault.delete(row.vaultToken);
    } catch (err) {
      this.logger.warn('payment_method_vault_delete_failed', {
        payment_method_id: row.id,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
