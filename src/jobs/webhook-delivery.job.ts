/**
 * WebhookDeliveryJob — every 15 seconds.
 *
 * Claims `pix_webhook_event_due`, signs, delivers, and turns the result into a status change.
 * The strategy does the HTTP; this job owns the retry budget, because a strategy that decides
 * its own retries is a strategy that retries differently from the other one.
 *
 * Delivery policy (domain-model.md §10): up to `WEBHOOK_MAX_ATTEMPTS` attempts over
 * `WEBHOOK_RETRY_WINDOW_HOURS`, exponential with jitter. A 410 Gone skips the budget
 * entirely — the merchant is telling us the endpoint will never accept again. 72h with no
 * success plus 20 consecutive dead events disables the endpoint, which is
 * `WebhookEndpointsService.disableStale`'s job and runs at the end of every pass.
 *
 * docs/runbooks/webhook-delivery.md.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import {
  selectStrategy,
  strategyNameForUrl,
  WEBHOOK_DELIVERY_STRATEGIES,
  type WebhookDeliveryStrategy,
} from '../webhooks/delivery/delivery.strategy';
import { isPermanentRejection, isSuccessStatus } from '../webhooks/delivery/delivery.types';
import type { WebhookEndpointEntity } from '../webhooks/webhook-endpoint.entity';
import { WebhookEndpointRepository } from '../webhooks/webhook-endpoint.repository';
import type { WebhookEventEntity } from '../webhooks/webhook-event.entity';
import { WebhookEventRepository } from '../webhooks/webhook-event.repository';
import { WebhookEndpointsService } from '../webhooks/webhook-endpoints.service';

import { backoffMs, JOB_BATCH_LIMITS, type JobResult } from './job.types';
import { ScheduledJob } from './scheduled-job';

/** Endpoints with this many consecutive failures and no success in 72h get disabled. */
const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;

@Injectable()
export class WebhookDeliveryJob extends ScheduledJob {
  readonly name = 'webhook-delivery';
  readonly cronExpression = '*/15 * * * * *';

  constructor(
    private readonly events: WebhookEventRepository,
    private readonly endpoints: WebhookEndpointRepository,
    private readonly endpointsService: WebhookEndpointsService,
    @Inject(WEBHOOK_DELIVERY_STRATEGIES)
    private readonly strategies: WebhookDeliveryStrategy[],
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('*/15 * * * * *', { name: 'webhook-delivery' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('webhook-delivery', 60)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const due = await this.events.claimDue(JOB_BATCH_LIMITS.webhookDelivery, this.clock.now());

      let failed = 0;
      for (const event of due) {
        const ok = await this.deliverOne(event);
        if (!ok) {
          failed += 1;
        }
      }

      const disabled = await this.endpointsService.disableStale(
        DISABLE_AFTER_CONSECUTIVE_FAILURES,
        20,
      );

      return {
        processed: due.length,
        failed,
        truncated: due.length >= JOB_BATCH_LIMITS.webhookDelivery,
        durationMs: Date.now() - startedMs,
        details: { endpoints_disabled: disabled.length },
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /**
   * One event. Returns false when the attempt did not succeed — including the terminal
   * cases, because "we gave up" is still a delivery that did not happen and the merchant's
   * dead-event count is what the console renders.
   */
  private async deliverOne(event: WebhookEventEntity): Promise<boolean> {
    const endpoint = await this.endpoints.findOne({ where: { id: event.endpointId } } as never);

    if (!endpoint) {
      // The endpoint was deleted between fanout and delivery. Nothing to deliver to and
      // nothing to retry; park the row so it stops being selected.
      await this.events.markDead(event.id, event.attemptCount, null, 'endpoint_deleted');
      return false;
    }

    const strategy = selectStrategy(this.strategies, strategyNameForUrl(endpoint.url));
    const attempt = event.attemptCount + 1;
    const result = await strategy.deliver(event, endpoint);

    if (isSuccessStatus(result.responseStatus)) {
      await this.events.markDelivered(event.id, result.responseStatus ?? 200, this.clock.now());
      await this.endpointsService.recordDeliveryOutcome(endpoint.id, true);

      this.logger.info('webhook.delivered', {
        webhook_event_id: event.id,
        endpoint_id: endpoint.id,
        merchant_id: event.merchantId,
        attempt,
        status: result.responseStatus,
        duration_ms: result.durationMs,
      });
      return true;
    }

    await this.endpointsService.recordDeliveryOutcome(endpoint.id, false);
    return this.recordFailure(event, endpoint, attempt, result.responseStatus, result.error);
  }

  private async recordFailure(
    event: WebhookEventEntity,
    endpoint: WebhookEndpointEntity,
    attempt: number,
    status: number | null,
    error: string | null,
  ): Promise<boolean> {
    const permanent = isPermanentRejection(status);
    const exhausted = attempt >= this.config.webhooks.maxAttempts;

    if (permanent || exhausted) {
      await this.events.markDead(event.id, attempt, status, error ?? reasonFor(permanent));

      this.logger.warn('webhook.dead', {
        webhook_event_id: event.id,
        endpoint_id: endpoint.id,
        merchant_id: event.merchantId,
        attempt,
        status,
        reason: permanent ? 'gone' : 'attempts_exhausted',
      });
      return false;
    }

    const delay = backoffMs(attempt, 1_000, this.config.webhooks.retryWindowHours * 3_600_000);
    const nextAttemptAt = new Date(this.clock.nowMs() + delay);

    await this.events.markRetrying(event.id, attempt, nextAttemptAt, status, error);

    this.logger.info('webhook.retry_scheduled', {
      webhook_event_id: event.id,
      endpoint_id: endpoint.id,
      attempt,
      status,
      next_attempt_at: nextAttemptAt.toISOString(),
    });
    return false;
  }
}

function reasonFor(permanent: boolean): string {
  return permanent ? 'endpoint returned 410 Gone' : 'retry budget exhausted';
}
