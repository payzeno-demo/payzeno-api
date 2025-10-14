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

import { ChargeNotFoundException, MerchantNotFoundException, ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { AuditService } from '../audit/audit.service';
import { BankAccountsService } from '../merchants/bank-accounts/bank-accounts.service';
import { MerchantsService } from '../merchants/merchants.service';
import { ChargesService } from '../payments/charges.service';
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
  kind: string;
  merchant_id: MerchantId;
  charge_id?: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  source_event_id: string;
}

@Injectable()
export class InternalService {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly webhookEndpoints: WebhookEndpointsService,
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
      const task = await this.supportTasks.open(tx, {
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
        resourceId: task.id,
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
        task_id: task.id,
        kind: input.kind,
        severity: input.severity,
        merchant_id: input.merchant_id,
        caller,
      });

      return { id: task.id };
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
  }
}
