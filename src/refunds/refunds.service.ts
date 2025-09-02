/**
 * RefundsService — L7. api-surface.md §6.
 *
 * The order of operations matters and it is not the obvious one:
 *
 *   1. open a transaction
 *   2. lock the charge, evaluate the policy, write the `refund` row as `pending`,
 *      bump `charge.refunded_amount_minor`, enqueue `refund.created` on the outbox
 *   3. COMMIT
 *   4. only then call the acquirer, and settle the row from its answer
 *
 * Calling the acquirer inside the transaction would hold the charge's row lock across a
 * network call to a system that took 22 minutes to answer once (PAY-2041), and every other
 * refund on that charge would queue behind it.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  ChargeId,
  ListQuery,
  Paginated,
  Refund,
  RefundId,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { BaseService } from '../common/base/base.service';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import { ledgerKey } from '../ledger/ledger.types';
import { ChargeRepository } from '../payments/charge.repository';
import { ProcessorRouter } from '../payments/processor/processor.router';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundEntity } from './refund.entity';
import { RefundRepository } from './refund.repository';
import { RefundPolicyService } from './refund-policy.service';
import { RefundStateMachine } from './state/refund.state-machine';

@Injectable()
export class RefundsService extends BaseService<RefundEntity> {
  constructor(
    private readonly refunds: RefundRepository,
    private readonly router: ProcessorRouter,
    private readonly ids: IdFactory,
  };
}
