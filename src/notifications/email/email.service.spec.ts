import type { EntityManager } from 'typeorm';

import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { ApiConfig } from 'src/config/api-config.type';
import type { EmailOutboxEntity } from 'src/notifications/email/email-outbox.entity';
import type { EmailOutboxRepository } from 'src/notifications/email/email-outbox.repository';
import { EmailService } from 'src/notifications/email/email.service';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * `queue()` is a write into the caller's transaction and nothing else — no SMTP, no rendering of
 * bodies. The properties: it lands in the manager it was handed (or the one in flight), the
 * address is normalised so the admin lookup finds it, and the subject is already rendered so
 * support can read what a queued or failed message says.
 */
describe('EmailService', () => {
  const clock = new FixedClock('2026-05-02T11:30:00.000Z');
  const config = { publicUrls: { console: 'http://console.test', admin: null } } as unknown as ApiConfig;
  const inFlight = { inFlight: true } as unknown as EntityManager;

  let outbox: { append: jest.Mock; lookup: jest.Mock };
  let service: EmailService;

  beforeEach(() => {
    outbox = {
      append: jest.fn().mockResolvedValue(undefined),
      lookup: jest.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }),
    };
    service = new EmailService(
      outbox as unknown as EmailOutboxRepository,
      { currentManager: () => inFlight } as unknown as TransactionManager,
      new IdFactory(),
      config,
      clock,
      new NoopLogger(),
    );
  });

  function appended(): { row: EmailOutboxEntity; manager: EntityManager } {
    const [row, manager] = outbox.append.mock.calls[0] as [EmailOutboxEntity, EntityManager];
    return { row, manager };
  }

  it('writes a queued, due-now row through the manager it was handed', async () => {
    const callerTx = { caller: true } as unknown as EntityManager;

    await service.queue(
      { template: 'team_invite', to: 'Dev@Acme.example ', data: { merchant_name: 'Acme', inviter_name: 'Ada' }, merchantId: 'mch_1' },
      callerTx,
    );

    const { row, manager } = appended();
    expect(manager).toBe(callerTx);
    expect(row).toMatchObject({
      template: 'team_invite',
      toAddress: 'dev@acme.example',
      subject: 'Ada invited you to Acme on Payzeno',
      merchantId: 'mch_1',
      livemode: true,
      status: 'queued',
      attemptCount: 0,
      sentAt: null,
    });
    expect(row.id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.nextAttemptAt).toEqual(clock.now());
  });

  it('joins the transaction in flight when the caller passed no manager', async () => {
    await service.queue({ template: 'password_reset', to: 'a@b.example', data: { reset_url: 'http://x' } });

    expect(appended().manager).toBe(inFlight);
  });

  it('keeps the data it was given, for rendering at send time', async () => {
    await service.queue({ template: 'receipt', to: 'shopper@x.example', data: { amount: '$5.00', card_last4: '4242' }, livemode: false });

    expect(appended().row.data).toEqual({ amount: '$5.00', card_last4: '4242' });
    expect(appended().row.livemode).toBe(false);
  });

  it('looks addresses up case-insensitively and answers metadata only', async () => {
    const row = {
      toEmailMessage: () => ({ id: 'msg_1', object: 'email_message', to: 'a@b.example' }),
    };
    outbox.lookup.mockResolvedValue({ data: [row], has_more: false, next_cursor: null });

    const page = await service.lookup({ to: ' A@B.example' }, { limit: 10 });

    expect(outbox.lookup).toHaveBeenCalledWith(
      { to: 'a@b.example' },
      expect.objectContaining({ limit: 10, cursor: null }),
    );
    expect(page.data).toEqual([{ id: 'msg_1', object: 'email_message', to: 'a@b.example' }]);
  });
});
