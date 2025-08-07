/**
 * 404. One subclass per aggregate that has a route of its own.
 *
 * They all serialise identically. The subclasses exist so a `THROWS` query can answer "what
 * can PaymentIntentsService fail with" without reading the string, and so MerchantScopeGuard
 * can turn a cross-tenant hit into the *same* class the repository would have thrown.
 */
import type { ChargeId, DisputeId, ErrorCode, MerchantId, PaymentIntentId } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export class ResourceNotFoundException extends ApiException {
  readonly code: ErrorCode = 'not_found';
  readonly httpStatus = 404;

  constructor(
    readonly resourceType: string,
    readonly resourceId: string | null = null,
    message?: string,
  ) {
    super(message ?? `No such ${resourceType}${resourceId ? `: ${resourceId}` : ''}`, {
      resource_type: resourceType,
      resource_id: resourceId,
    });
  }
}

export class MerchantNotFoundException extends ResourceNotFoundException {
  constructor(merchantId: MerchantId | null = null) {
    super('merchant', merchantId);
  }
}

export class PaymentIntentNotFoundException extends ResourceNotFoundException {
  constructor(paymentIntentId: PaymentIntentId | null = null) {
    super('payment_intent', paymentIntentId);
  }
}

export class ChargeNotFoundException extends ResourceNotFoundException {
  constructor(chargeId: ChargeId | null = null) {
    super('charge', chargeId);
  }
}

export class DisputeNotFoundException extends ResourceNotFoundException {
  constructor(disputeId: DisputeId | null = null) {
    super('dispute', disputeId);
  }
}
