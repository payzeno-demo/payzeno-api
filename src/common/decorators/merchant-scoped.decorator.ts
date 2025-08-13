/**
 * `@MerchantScoped()` — marks a controller whose resources belong to exactly one merchant.
 *
 * MerchantScopeGuard reads the marker and refuses to run on a controller that has not
 * declared it, so forgetting the decorator fails closed instead of serving another tenant's
 * rows.
 *
 * Sites: MerchantsController, PaymentIntentsController, ChargesController,
 * RefundsController, DisputesController, PayoutsController, SettlementsController,
 * WebhookEventsController.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const MERCHANT_SCOPED_KEY = 'payzeno:merchant_scoped';

export interface MerchantScopedOptions {
  /**
   * Route param holding the scoped resource id. When set, MerchantScopeGuard resolves the
   * resource and 404s on a tenant mismatch instead of relying on the repository predicate.
   */
  idParam?: string;
  /** Staff sessions must pass `?merchant_id=`; default true. */
  requireStaffMerchantId?: boolean;
}

export const MerchantScoped = (options: MerchantScopedOptions = {}): CustomDecorator =>
  SetMetadata(MERCHANT_SCOPED_KEY, { requireStaffMerchantId: true, ...options });
