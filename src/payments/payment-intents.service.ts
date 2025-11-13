/**
 * PaymentIntentsService — the product's centre of gravity, and deliberately thin.
 *
 * Everything multi-aggregate delegates to a `PaymentFlow`. What is left here is what a
 * merchant-facing service should own: tenant scoping, the 404, the create write, and the
 * decision of which flow answers which route. When this file grows a `try { … acquirer … }`
 * block, the review comment is a link to `flows/payment.flow.ts`.
 *
 * Hot file: twelve months of churn, four authors. Keep it boring.
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  AuthPrincipal,
  CancelPaymentIntentRequest,
  CapturePaymentIntentRequest,
  ConfirmPaymentIntentRequest,
  Paginated,
  PaymentIntent,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { PaymentIntentNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CancelPaymentFlow } from './flows/cancel-payment.flow';
import { CapturePaymentFlow } from './flows/capture-payment.flow';
import { ConfirmPaymentFlow } from './flows/confirm-payment.flow';
import { PaymentIntentEntity } from './payment-intent.entity';
import { PaymentIntentRepository } from './payment-intent.repository';

@Injectable()
export class PaymentIntentsService extends BaseService<PaymentIntentEntity> {
  constructor(
    private readonly intents: PaymentIntentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    const row = await this.intents.findByClientSecret(clientSecret);
    if (!row) {
      throw new PaymentIntentNotFoundException(null);
    }
    return row;
  }

  /** Terminal intents accept a metadata patch and nothing else (domain-model §2). */
  async patchMetadata(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    metadata: Record<string, string>,
  ): Promise<PaymentIntent> {
  } as PaymentIntent;
}
