import type { DistributedLock } from 'src/common/lock/distributed-lock';
import { NoopLogger } from 'src/common/logging/logger';
import type { ApiConfig } from 'src/config/api-config.type';
import { EMAIL_MAX_ATTEMPTS, EmailDeliveryJob } from 'src/notifications/email/email-delivery.job';
import { EmailOutboxEntity } from 'src/notifications/email/email-outbox.entity';
import type { EmailOutboxRepository } from 'src/notifications/email/email-outbox.repository';
import { MailSendError, type MailTransport } from 'src/notifications/email/smtp.transport';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * The retry budget is the job's, as for webhooks. Three outcomes per message: sent; a relay
 * that is not there yet (Mailpit still starting, a timeout) is retried with backoff computed
 * from the INJECTED clock — the stack runs on simulated time; and a relay that refuses the
 * message for good (SMTP 5xx), or the last attempt, is `failed`.
 */
describe('EmailDeliveryJob', () => {
  const clock = new FixedClock('2026-05-02T11:30:00.000Z');
  const config = {
    email: { from: 'Payzeno <no-reply@payzeno.com>' },
    publicUrls: { console: 'http://console.test', admin: null },
  } as unknown as ApiConfig;

  let outbox: { claimDue: jest.Mock; markSent: jest.Mock; markRetry: jest.Mock; markFailed: jest.Mock };
  let transport: { send: jest.Mock };
  let lock: { acquire: jest.Mock; release: jest.Mock; extend: jest.Mock };
  let job: EmailDeliveryJob;

  function message(overrides: Partial<EmailOutboxEntity> = {}): EmailOutboxEntity {
    const row = new EmailOutboxEntity();
    Object.assign(row, {
      id: 'msg_01HZEMAIL0000000000000001',
      template: 'signup_verify',
      toAddress: 'owner@acme.example',
      subject: 'Confirm your email to finish setting up Acme on Payzeno',
      data: { merchant_name: 'Acme', verify_url: 'http://console.test/verify-email?token=t' },
      merchantId: 'mch_1',
      livemode: true,
      status: 'queued',
      attemptCount: 0,
      nextAttemptAt: clock.now(),
      lastError: null,
      providerMessageId: null,
      sentAt: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...overrides,
    });
    return row;
  }

  beforeEach(() => {
    outbox = {
      claimDue: jest.fn().mockResolvedValue([message()]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markRetry: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    transport = { send: jest.fn().mockResolvedValue({ providerMessageId: '<abc@mailpit>' }) };
    lock = {
      acquire: jest.fn().mockResolvedValue({ name: 'email-delivery', token: 't' }),
      release: jest.fn().mockResolvedValue(true),
      extend: jest.fn(),
    };
    job = new EmailDeliveryJob(
      outbox as unknown as EmailOutboxRepository,
      transport as unknown as MailTransport,
      config,
      clock,
      lock as unknown as DistributedLock,
      new NoopLogger(),
    );
  });

  it('claims due rows with a lease from the injected clock', async () => {
    await job.runOnce();

    expect(outbox.claimDue).toHaveBeenCalledWith(25, clock.now(), clock.plusSeconds(300));
  });

  it('renders, sends from EMAIL_FROM with tracing headers, and marks the row sent', async () => {
    const result = await job.runOnce();

    const [mail] = transport.send.mock.calls[0];
    expect(mail).toMatchObject({
      from: 'Payzeno <no-reply@payzeno.com>',
      to: 'owner@acme.example',
      subject: 'Confirm your email to finish setting up Acme on Payzeno',
      headers: { 'X-Payzeno-Email-Id': 'msg_01HZEMAIL0000000000000001', 'X-Payzeno-Template': 'signup_verify' },
    });
    expect(mail.text).toContain('http://console.test/verify-email?token=t');
    expect(outbox.markSent).toHaveBeenCalledWith('msg_01HZEMAIL0000000000000001', 1, clock.now(), '<abc@mailpit>');
    expect(result).toMatchObject({ processed: 1, failed: 0 });
  });

  it('retries a relay that is not reachable, later, by the injected clock', async () => {
    transport.send.mockRejectedValue(new MailSendError('ECONNREFUSED connect ECONNREFUSED sim-mail:1025', false));

    const result = await job.runOnce();

    expect(outbox.markFailed).not.toHaveBeenCalled();
    const [id, attempt, nextAttemptAt, error] = outbox.markRetry.mock.calls[0] as [string, number, Date, string];
    expect(id).toBe('msg_01HZEMAIL0000000000000001');
    expect(attempt).toBe(1);
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(clock.nowMs() + 10_000);
    expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(clock.nowMs() + 15 * 60_000);
    expect(error).toContain('ECONNREFUSED');
    expect(result).toMatchObject({ processed: 1, failed: 1 });
  });

  it('fails a message the relay refused for good without retrying it', async () => {
    transport.send.mockRejectedValue(new MailSendError('550 mailbox unavailable', true));

    await job.runOnce();

    expect(outbox.markFailed).toHaveBeenCalledWith('msg_01HZEMAIL0000000000000001', 1, '550 mailbox unavailable');
    expect(outbox.markRetry).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt', async () => {
    outbox.claimDue.mockResolvedValue([message({ attemptCount: EMAIL_MAX_ATTEMPTS - 1 })]);
    transport.send.mockRejectedValue(new MailSendError('ETIMEDOUT', false));

    await job.runOnce();

    expect(outbox.markFailed).toHaveBeenCalledWith(expect.any(String), EMAIL_MAX_ATTEMPTS, 'ETIMEDOUT');
  });

  it('does nothing when another task holds the lease', async () => {
    lock.acquire.mockResolvedValue(null);

    const result = await job.runOnce();

    expect(outbox.claimDue).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ skipped: 'lock_not_acquired' });
  });
});
