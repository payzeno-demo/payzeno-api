import type { EntityManager } from 'typeorm';
import { WebhookEventsService } from './webhook-events.service';

describe('WebhookEventsService', () => {
  const now = new Date('2026-05-02T12:00:00.000Z');
  const tx = {} as EntityManager;

  let service: WebhookEventsService;

  it('creates rows pending and immediately due', async () => {
    await service.fanout(tx, {
      sourceEventId: 'evt_bus_2',
      merchantId: 'mer_1',
      type: 'refund.failed',
      payload: {},
      livemode: false,
      endpoints: [{ id: 'whe_1' }] as never,
    });

    const [, rows] = repo.insertIgnoringSourceConflict.mock.calls[0];
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attemptCount).toBe(0);
    expect(rows[0].nextAttemptAt).toEqual(now);
    expect(rows[0].signatureVersion).toBe('v1');
  });

  it('is a no-op when the merchant has no endpoints', async () => {
    const inserted = await service.fanout(tx, {
      sourceEventId: 'evt_bus_3',
      merchantId: 'mer_1',
      type: 'payment.failed',
      payload: {},
      livemode: true,
      endpoints: [],
    });

    expect(inserted).toBe(0);
  });

  it('404s a webhook_event that belongs to another merchant', async () => {
    await expect(service.get('mer_2', 'evt_1')).rejects.toThrow(/webhook_event/);
  });

  it('refuses to redeliver a row that is mid-flight', async () => {
    repo.findOneBy.mockResolvedValueOnce({ id: 'evt_1', status: 'delivering', attemptCount: 2 });

    await expect(service.redeliver('mer_1', 'evt_1')).rejects.toThrow(/already in flight/);
  });

  it('requeues a dead row without resetting its attempt history', async () => {
    repo.findOneBy
      .mockResolvedValueOnce({
        id: 'evt_1',
        status: 'dead',
        attemptCount: 12,
        lastResponseStatus: 500,
        lastError: 'boom',
        merchantId: 'mer_1',
        endpointId: 'whe_1',
        type: 'payout.failed',
        sourceEventId: 'evt_bus_1',
        payload: {},
        signatureVersion: 'v1',
        livemode: true,
        createdAt: now,
        deliveredAt: null,
        nextAttemptAt: null,
      })
      .mockResolvedValueOnce(null);

    await service.redeliver('mer_1', 'evt_1');

    expect(repo.markRetrying).toHaveBeenCalledWith('evt_1', 12, now, 500, 'boom');
  });
});
