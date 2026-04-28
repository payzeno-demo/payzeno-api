import type { DataSource, EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import type { Clock } from 'src/common/time/clock';
import type { IdFactory } from 'src/common/ids/id.factory';
import { SupportTaskEntity } from 'src/support/support-task.entity';
import { SupportTasksService } from 'src/support/support-tasks.service';

/**
 * arc INC's sink. Two properties, both learned on 2026-04-28.
 *
 * `open()` takes the caller's EntityManager rather than starting its own transaction. That is
 * what makes the task and the `processed_event` claim atomic: if the consumer's handler rolls
 * back, the task rolls back with it and the redelivery writes it again. A service that opened
 * its own transaction here would leave a task behind for a handler that failed, and the
 * remediation queue would have contained rows for charges that were never double-captured.
 *
 * `ON CONFLICT DO NOTHING` on `uq_support_task_source_event` is the other half: the same event
 * redelivered by SQS must not produce a second task. `RETURNING id` is how the service knows
 * which of the two happened, and the id it returns on the suppressed path is the EXISTING
 * task's — the caller logs it, and logging a row id that is not in the table sent two people
 * down a dead end during the incident.
 */
describe('SupportTasksService', () => {
  const NOW = new Date('2026-04-28T09:14:00.000Z');
  const MERCHANT = 'mch_01HQ8ZZZ0000000000000001';
  interface InsertBuilder {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  }

  let repositoryFindOne: jest.Mock;
  let manager: EntityManager;
  let dataSource: DataSource;
  let ids: jest.Mocked<Pick<IdFactory, 'opaque'>>;
  beforeEach(() => {
    insertBuilder = {
      insert: jest.fn(() => insertBuilder),
      into: jest.fn(() => insertBuilder),
      values: jest.fn(() => insertBuilder),
      orIgnore: jest.fn(() => insertBuilder),
      returning: jest.fn(() => insertBuilder),
      execute: jest.fn(async () => ({ raw: [{ id: 'sup_generated' }] })),
    };

    updateBuilder = {
      update: jest.fn(() => updateBuilder),
      set: jest.fn(() => updateBuilder),
      where: jest.fn(() => updateBuilder),
      andWhere: jest.fn(() => updateBuilder),
      execute: jest.fn(async () => ({ affected: 1 })),
    };

    selectBuilder = {
      where: jest.fn(() => selectBuilder),
      andWhere: jest.fn(() => selectBuilder),
      orderBy: jest.fn(() => selectBuilder),
      addOrderBy: jest.fn(() => selectBuilder),
      take: jest.fn(() => selectBuilder),
      getMany: jest.fn(async () => []),
    };

    repositoryFindOne = jest.fn(async () => null);

    manager = { createQueryBuilder: jest.fn(() => insertBuilder) } as unknown as EntityManager;

    dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager)),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn((alias?: string) => (alias ? selectBuilder : updateBuilder)),
        findOne: repositoryFindOne,
      })),
    } as unknown as DataSource;

    ids = { opaque: jest.fn(() => 'sup_01HQ8ZZZ0000000000000009') } as never;
    logger = new NoopLogger();

    service = new SupportTasksService(
      dataSource,
      ids as unknown as IdFactory,
      { nowMs: () => NOW.getTime(), now: () => NOW } as Clock,
      logger,
    );
  });

  describe('openStandalone', () => {
    it('wraps open() in its own transaction for callers with no ambient one', async () => {
      await service.openStandalone(input);

      // POST /internal/v1/support-tasks and the legacy biller's DunningService.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(insertBuilder.execute).toHaveBeenCalled();
    });
  });

  describe('listOpenByKind', () => {
    it('orders by severity first, then oldest first', async () => {
      await service.listOpenByKind('duplicate_settlement');

      const [orderExpression] = selectBuilder.orderBy.mock.calls[0] as [string];

      expect(orderExpression).toContain("when 'critical' then 0");
      expect(selectBuilder.addOrderBy).toHaveBeenCalledWith('support_task.created_at', 'ASC');
    });

    it('takes 200 by default — the whole remediation queue in one page', async () => {
      await service.listOpenByKind('duplicate_settlement');

      expect(selectBuilder.take).toHaveBeenCalledWith(200);
    });
  });

  describe('resolve', () => {
    it('sets the resolution and stamps the clock', async () => {
      await service.resolve('sup_1', 'refunded via PAY-2042 batch', 'stf_0001');

      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'resolved',
          resolvedAt: NOW,
          resolutionNote: 'refunded via PAY-2042 batch',
          assignedTo: 'stf_0001',
        }),
      );
    });

    it('will not re-resolve a task that is already resolved', async () => {
      await service.resolve('sup_1', 'note', 'stf_0001');

      expect(updateBuilder.andWhere).toHaveBeenCalledWith("status in ('open', 'acknowledged')");
    });

    it('logs how many rows it actually touched', async () => {
      const info = jest.spyOn(logger, 'info');
      updateBuilder.execute.mockResolvedValue({ affected: 0 });

      await service.resolve('sup_gone', 'note', 'stf_0001');

      expect(info).toHaveBeenCalledWith(
        'support_task.resolved',
        expect.objectContaining({ affected: 0 }),
      );
    });
  });
});
