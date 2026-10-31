/**
 * EmailDeliveryJob — every 10 seconds. RFC platform-v2 §2.
 *
 * Claims due `email_outbox` rows (leased, see `EmailOutboxRepository.claimDue`), renders each
 * one and hands it to the SMTP transport. The job owns the retry budget, exactly like
 * `WebhookDeliveryJob`: exponential backoff with jitter from 10s up to 15 minutes, at most
 * `MAX_ATTEMPTS` attempts (about two hours of trying), then `failed`. An SMTP 5xx is the relay
 * refusing this particular message and fails it at once.
 *
 * Registered by `EmailModule` rather than `JobsModule`: it reaches into nothing but its own
 * module, and `ScheduleModule.forRoot()` (imported once, in JobsModule) discovers `@Cron`
 * providers app-wide. A relay that is down — Mailpit not started yet, SES throttling — is a
 * queue that waits, not an error: every attempt logs at warn and the row is retried.
 *
 * `next_attempt_at` is computed from the injected Clock. Locally the stack runs on simulated
 * time; reading `Date.now()` here would schedule retries in a different century from the rows.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JobLock } from '../../common/decorators/job-lock.decorator';
import { DISTRIBUTED_LOCK, type DistributedLock } from '../../common/lock/distributed-lock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { CLOCK, type Clock } from '../../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { backoffMs, type JobResult } from '../../jobs/job.types';
import { ScheduledJob } from '../../jobs/scheduled-job';

import type { EmailOutboxEntity } from './email-outbox.entity';
import { EmailOutboxRepository } from './email-outbox.repository';
import { domainOf } from './email.service';
import { MAIL_TRANSPORT, MailSendError, type MailTransport } from './smtp.transport';
import { renderEmail } from './templates/email-templates';

export const EMAIL_DELIVERY_BATCH = 25;
export const EMAIL_MAX_ATTEMPTS = 12;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 15 * 60_000;
/** Longer than one batch of sends at the transport's timeouts, so a slow batch keeps its rows. */
const CLAIM_LEASE_SEC = 5 * 60;

@Injectable()
export class EmailDeliveryJob extends ScheduledJob {
  readonly name = 'email-delivery';
  readonly cronExpression = '*/10 * * * * *';

  constructor(
    private readonly outbox: EmailOutboxRepository,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISTRIBUTED_LOCK) lock: DistributedLock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(lock, logger);
  }

  @Cron('*/10 * * * * *', { name: 'email-delivery' })
  async run(): Promise<JobResult> {
    return this.execute();
  }

  @JobLock('email-delivery', 60)
  async runOnce(): Promise<JobResult> {
    const startedMs = Date.now();

    const result = await this.withLock(async () => {
      const due = await this.outbox.claimDue(
        EMAIL_DELIVERY_BATCH,
        this.clock.now(),
        this.clock.plusSeconds(CLAIM_LEASE_SEC),
      );

      let failed = 0;
      for (const message of due) {
        if (!(await this.deliverOne(message))) failed += 1;
      }

      return {
        processed: due.length,
        failed,
        truncated: due.length >= EMAIL_DELIVERY_BATCH,
        durationMs: Date.now() - startedMs,
      } satisfies JobResult;
    });

    return result ?? this.skipped();
  }

  /** One message. False when this attempt did not deliver it, retry scheduled or not. */
  private async deliverOne(message: EmailOutboxEntity): Promise<boolean> {
    const attempt = message.attemptCount + 1;

    try {
      const rendered = renderEmail(message.template, message.data, {
        consoleUrl: this.config.publicUrls.console,
      });
      const sent = await this.transport.send({
        from: this.config.email.from,
        to: message.toAddress,
        subject: message.subject,
        html: rendered.html,
        text: rendered.text,
        headers: { 'X-Payzeno-Email-Id': message.id, 'X-Payzeno-Template': message.template },
      });

      await this.outbox.markSent(message.id, attempt, this.clock.now(), sent.providerMessageId);
      this.logger.info('email.sent', {
        email_id: message.id,
        template: message.template,
        to_domain: domainOf(message.toAddress),
        attempt,
      });
      return true;
    } catch (err) {
      await this.recordFailure(message, attempt, err);
      return false;
    }
  }

  private async recordFailure(message: EmailOutboxEntity, attempt: number, err: unknown): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof MailSendError && err.permanent;

    if (permanent || attempt >= EMAIL_MAX_ATTEMPTS) {
      await this.outbox.markFailed(message.id, attempt, error);
      this.logger.warn('email.failed', {
        email_id: message.id,
        template: message.template,
        attempt,
        permanent,
        error,
      });
      return;
    }

    const nextAttemptAt = new Date(this.clock.nowMs() + backoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
    await this.outbox.markRetry(message.id, attempt, nextAttemptAt, error);
    this.logger.warn('email.retry_scheduled', {
      email_id: message.id,
      template: message.template,
      attempt,
      next_attempt_at: nextAttemptAt.toISOString(),
      error,
    });
  }
}
