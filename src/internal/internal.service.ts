/**
 * InternalService — the six service-to-service use cases of api-surface.md §9b.
 *
 * These routes exist for the cases a projection cannot serve: a cold read after an orphaned
 * reconciliation item, a support task raised by the ledger's `settlement.duplicate_detected`
 * branch, and a fanout decision that must not be stale. The **normal** path for merchant
 * config and bank details in the ledger is `merchant_projection` / `bank_account_projection`,
 * fed by the bus (data-model.md §3.8, §3.11). Nothing here is a substitute for that, and a
 * caller that starts reading these on the hot path is a caller with a bug.
 *
 * Every mutation is audited under the `internal_service` actor type, because during the
 * PAY-2041 remediation the question "who marked this charge settled" had to be answerable
 * for 218 charges and the answer was not in any log we had.
 *
 * docs/adr/0001-nestjs-module-boundaries.md — this is an L7 service: it calls services and
 * repositories, and never a transport directly.
 */
import { Injectable, Inject } from '@nestjs/common';

import type {
  BankAccount,
  Charge,
  IsoTimestamp,
  Merchant,
  MerchantId,
  WebhookEndpoint,
} from '@payzeno/contracts';

import { MerchantNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { AuditService } from '../audit/audit.service';
import { BankAccountsService } from '../merchants/bank-accounts/bank-accounts.service';
import { MerchantsService, toMerchantResponse } from '../merchants/merchants.service';
import { ChargesService } from '../payments/charges.service';
import type { SupportTaskKind, SupportTaskSeverity } from '../support/support-task.entity';
import { SupportTasksService } from '../support/support-tasks.service';
import { WebhookEndpointsService } from '../webhooks/webhook-endpoints.service';

/** Which service is on the other end. Comes off the `internal_service` principal. */
export type InternalCallerName = 'payzeno-ledger' | 'payzeno-billing-legacy';

/** Body of `POST /internal/v1/charges/:chargeId/settled`. */
export interface MarkChargeSettledInput {
  settlement_batch_id: string;
  settled_at: IsoTimestamp;
  transaction_id: string;
}

/** Body of `POST /internal/v1/support-tasks`. */
export interface CreateSupportTaskInput {
  kind: SupportTaskKind;
  merchant_id: MerchantId;
  charge_id?: string | null;
  severity: SupportTaskSeverity;
  title: string;
  body: string;
  source_event_id: string;
}

@Injectable()
export class InternalService {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly charges: ChargesService,
    private readonly bankAccounts: BankAccountsService,
    private readonly webhookEndpoints: WebhookEndpointsService,
    private readonly supportTasks: SupportTasksService,
    private readonly transactions: TransactionManager,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** `GET /internal/v1/merchants/:merchantId`. Ledger config reads and the legacy profile sync. */
  async getMerchant(merchantId: MerchantId, caller: InternalCallerName): Promise<Merchant> {
    const merchant = await this.merchants.findInternal(merchantId);

    if (!merchant) {
      throw new MerchantNotFoundException(merchantId);
    }

    this.logger.debug('internal.merchant_read', { merchant_id: merchantId, caller });
    return toMerchantResponse(merchant);
  }

  /** `GET /internal/v1/charges/:chargeId`. The ledger reconciling an orphaned item. */
  async getCharge(chargeId: string, caller: InternalCallerName): Promise<Charge> {
    // Throws ChargeNotFoundException for an orphan we have no row for.
    const charge = await this.charges.getInternal(chargeId);

    this.logger.debug('internal.charge_read', { charge_id: chargeId, caller });
    return charge;
  }

  /**
   * `POST /internal/v1/charges/:chargeId/settled`.
   *
   * The out-of-band settle. `settlement.completed` is the normal driver of
   * `captured -> settled`; this exists for the single orphan resolved by hand, and for the
   * charges `UnsettledChargeSweepJob` finds that no chunk ever covered. It reuses the same
   * write path as the event branch so the two can never diverge — one code path, two
   * triggers.
   */
  async markChargeSettled(
    chargeId: string,
    input: MarkChargeSettledInput,
    caller: InternalCallerName,
  ): Promise<Charge> {
    return this.transactions.runInTransaction(async (tx) => {
      const marked = await this.charges.markSettledFromBatch(tx, [chargeId], {
        settlementBatchId: input.settlement_batch_id,
        settledAt: input.settled_at,
      });

      if (marked === 0) {
        // Already settled, or never captured. Both are no-ops for the caller, but the second
        // is worth an audit row: the ledger believes it settled something we never captured.
        this.logger.warn('internal.charge_settle_noop', {
          charge_id: chargeId,
          batch_id: input.settlement_batch_id,
          caller,
        });
      }

      await this.audit.record(tx, {
        merchantId: null,
        actorType: 'internal_service',
        actorId: caller,
        action: 'charge.settled.out_of_band',
        resourceType: 'charge',
        resourceId: chargeId,
        before: null,
        after: {
          settlement_batch_id: input.settlement_batch_id,
          transaction_id: input.transaction_id,
          settled_at: input.settled_at,
          rows_affected: marked,
        },
        livemode: true,
      });

      return this.charges.getInternal(chargeId);
    });
  }

  /**
   * `GET /internal/v1/webhook_endpoints?merchant_id=`.
   *
   * The ledger asks this before it bothers publishing a merchant-facing event. It is a
   * fanout-worthiness check, so it must not be served from a projection that could be an
   * hour stale — a merchant who just added an endpoint would silently miss the next event.
   */
  async listWebhookEndpoints(
    merchantId: MerchantId,
    status: 'enabled' | 'disabled' | undefined,
    caller: InternalCallerName,
  ): Promise<{ data: WebhookEndpoint[]; has_more: boolean }> {
    const endpoints = await this.webhookEndpoints.listForInternalCaller(merchantId, status);

    this.logger.debug('internal.webhook_endpoints_read', {
      merchant_id: merchantId,
      caller,
      count: endpoints.length,
    });

    return { data: endpoints, has_more: false };
  }

  /**
   * `POST /internal/v1/support-tasks`.
   *
   * arc INC. This is the ledger's escape hatch when it refuses a duplicate posting and the
   * merchant is on capture-at-settlement — the cardholder may genuinely have been charged
   * twice, and that is a human's problem within the hour, not a metric's problem overnight.
   */
  async createSupportTask(
    input: CreateSupportTaskInput,
    caller: InternalCallerName,
  ): Promise<{ id: string }> {
    return this.transactions.runInTransaction(async (tx) => {
      const taskId = await this.supportTasks.open(tx, {
        kind: input.kind,
        merchantId: input.merchant_id,
        chargeId: input.charge_id ?? null,
        severity: input.severity,
        title: input.title,
        body: input.body,
        sourceEventId: input.source_event_id,
      });

      await this.audit.record(tx, {
        merchantId: input.merchant_id,
        actorType: 'internal_service',
        actorId: caller,
        action: 'support_task.open',
        resourceType: 'support_task',
        resourceId: taskId,
        before: null,
        after: {
          kind: input.kind,
          severity: input.severity,
          charge_id: input.charge_id ?? null,
          source_event_id: input.source_event_id,
        },
        livemode: true,
      });

      this.logger.info('internal.support_task_created', {
        task_id: taskId,
        kind: input.kind,
        severity: input.severity,
        merchant_id: input.merchant_id,
        caller,
      });

      return { id: taskId };
    });
  }

  /**
   * `GET /internal/v1/bank-accounts/:bankAccountId`.
   *
   * Fallback only, for when `bank_account_projection` is stale. The account number is a
   * vault token here as it is everywhere else — payzeno never holds the digits.
   */
  async getBankAccount(
    bankAccountId: string,
    caller: InternalCallerName,
  ): Promise<BankAccount> {
    // Throws ResourceNotFoundException('bank_account') when there is no such row.
    const account = await this.bankAccounts.getForInternal(bankAccountId);

    this.logger.debug('internal.bank_account_read', {
      bank_account_id: bankAccountId,
      caller,
    });
    return account.toBankAccount();
  }

  /** Stamped on responses so a caller can tell a cold read from a cached one. */
  readAt(): IsoTimestamp {
    return this.clock.nowIso();
  }
}
