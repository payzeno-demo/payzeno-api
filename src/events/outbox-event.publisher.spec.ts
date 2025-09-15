import type { EntityManager } from 'typeorm';
import { OutboxEventPublisher } from './outbox-event.publisher';
import type { PublishContext } from './publisher.types';

describe('OutboxEventPublisher', () => {
  const now = new Date('2026-04-01T12:00:00.000Z');
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
