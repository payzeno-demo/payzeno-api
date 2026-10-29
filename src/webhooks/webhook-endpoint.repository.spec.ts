import type { DataSource, SelectQueryBuilder } from 'typeorm';

import type { WebhookEndpointEntity } from 'src/webhooks/webhook-endpoint.entity';
import { WebhookEndpointRepository } from 'src/webhooks/webhook-endpoint.repository';

/**
 * domain-model.md §10: an endpoint is disabled after 72h with no success AND 20+ consecutive
 * failures. "No success" for an endpoint that has never succeeded is measured from its creation.
 */
describe('WebhookEndpointRepository.findStale', () => {
  it('measures "72h with no success" from creation when the endpoint never succeeded', async () => {
    // Regression: `last_success_at is null` matched outright, so a new endpoint whose receiver
    // was down for half an hour was disabled after its 20th failed attempt.
    const andWhere = jest.fn();
    const chain = {
      where: jest.fn(),
      andWhere,
      limit: jest.fn(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    for (const step of [chain.where, chain.andWhere, chain.limit]) {
      step.mockReturnValue(chain);
    }
    const repository = new WebhookEndpointRepository({ createEntityManager: () => ({}) } as unknown as DataSource);
    jest
      .spyOn(repository, 'createQueryBuilder')
      .mockReturnValue(chain as unknown as SelectQueryBuilder<WebhookEndpointEntity>);
    const olderThan = new Date('2026-01-12T12:00:00.000Z');

    await repository.findStale(olderThan, 20, 50);

    expect(andWhere).toHaveBeenCalledWith('coalesce(e.last_success_at, e.created_at) < :olderThan', { olderThan });
    expect(andWhere.mock.calls.some(([clause]) => String(clause).includes('last_success_at is null'))).toBe(false);
  });
});
