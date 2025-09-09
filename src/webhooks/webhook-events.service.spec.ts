import type { EntityManager } from 'typeorm';
import { WebhookEventsService } from './webhook-events.service';

describe('WebhookEventsService', () => {
  const now = new Date('2026-05-02T12:00:00.000Z');
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
