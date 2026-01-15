import type { EntityManager } from 'typeorm';
import { OutboxEventPublisher } from './outbox-event.publisher';
import type { PublishContext } from './publisher.types';

describe('OutboxEventPublisher', () => {
  const now = new Date('2026-04-01T12:00:00.000Z');
  const ctx: PublishContext = {
    merchantId: 'mer_1',
    correlationId: 'corr_1',
    causationId: null,
    livemode: true,
    occurredAt: '2026-04-01T11:59:59.000Z',
  };

  beforeEach(() => {
    outbox = { enqueue: jest.fn(async () => 'evt_1') };
    transactions = {
      currentManager: jest.fn(() => tx),
      isInTransaction: jest.fn(() => true),
    };

    publisher = new OutboxEventPublisher(
      outbox as never,
      transactions as never,
      { generate: () => 'evt_01HTEST' } as never,
      { now: () => now } as never,
      { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
    );
  });

  it('starts a fresh row unpublished and immediately due', async () => {
    await publisher.publish(
      'refund.created',
      {
        refund_id: 'ref_1',
        charge_id: 'ch_1',
        merchant_id: 'mer_1',
        amount_minor: 500,
        currency: 'USD',
        reason: 'requested_by_customer',
        nets_against_settlement: false,
        created_at: '2026-04-01T11:59:59.000Z',
      },
      ctx,
    );

    const [, row] = outbox.enqueue.mock.calls[0];
    expect(row.publishedAt).toBeNull();
    expect(row.deadAt).toBeNull();
    expect(row.attemptCount).toBe(0);
    expect(row.nextAttemptAt).toEqual(now);
    expect(row.occurredAt).toEqual(new Date('2026-04-01T11:59:59.000Z'));
  });

  it('refuses to publish an event payzeno-api does not own', async () => {
    await expect(
      publisher.publish(
        'settlement.completed',
        {} as never,
        ctx,
      ),
    ).rejects.toThrow('payzeno-api does not own event type "settlement.completed"');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
