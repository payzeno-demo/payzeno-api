import type { DataSource, EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import type { Clock } from 'src/common/time/clock';
import type { IdFactory } from 'src/common/ids/id.factory';
import { ConflictException } from 'src/common/errors/api.exception';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
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
  const CHARGE = 'ch_01HQ8ZZZ0000000000000002';

  interface InsertBuilder {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  }

  interface UpdateBuilder {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  }

  interface SelectBuilder {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
  }

  let insertBuilder: InsertBuilder;
  let updateBuilder: UpdateBuilder;
  let selectBuilder: SelectBuilder;
  let repositoryFindOne: jest.Mock;
  let manager: EntityManager;
  let dataSource: DataSource;
  let ids: jest.Mocked<Pick<IdFactory, 'opaque'>>;
  let logger: NoopLogger;
  let service: SupportTasksService;

  const input = {
    kind: 'duplicate_settlement' as const,
    merchantId: MERCHANT,
    chargeId: CHARGE,
    severity: 'critical' as const,
    title: 'Possible double capture on ch_01HQ8ZZZ0000000000000002',
    body: 'settlement.duplicate_detected arrived for a capture_at_settlement merchant',
    sourceEventId: 'evt_01HQ8ZZZ0000000000000003',
  };

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

  describe('open', () => {
    it('writes through the caller EntityManager, never its own transaction', async () => {
      await service.open(manager, input);

      expect(manager.createQueryBuilder).toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('inserts a task built from the input', async () => {
      await service.open(manager, input);

      const [task] = insertBuilder.values.mock.calls[0] as [SupportTaskEntity];

      expect(task).toMatchObject({
        merchantId: MERCHANT,
        chargeId: CHARGE,
        kind: 'duplicate_settlement',
        severity: 'critical',
        status: 'open',
        sourceEventId: 'evt_01HQ8ZZZ0000000000000003',
      });
    });

    it('mints an sup_ prefixed id', async () => {
      await service.open(manager, input);

      expect(ids.opaque).toHaveBeenCalledWith('sup_');
    });

    it('stamps both timestamps from the injected clock', async () => {
      await service.open(manager, input);

      const [task] = insertBuilder.values.mock.calls[0] as [SupportTaskEntity];

      expect(task.createdAt).toEqual(NOW);
      expect(task.updatedAt).toEqual(NOW);
    });

    it('opens unassigned and unresolved', async () => {
      await service.open(manager, input);

      const [task] = insertBuilder.values.mock.calls[0] as [SupportTaskEntity];

      expect(task.assignedTo).toBeNull();
      expect(task.resolvedAt).toBeNull();
      expect(task.resolutionNote).toBeNull();
    });

    it('defaults livemode to true — the incident was a livemode event', async () => {
      await service.open(manager, input);

      const [task] = insertBuilder.values.mock.calls[0] as [SupportTaskEntity];

      expect(task.livemode).toBe(true);
    });

    it('honours an explicit livemode false', async () => {
      await service.open(manager, { ...input, livemode: false });

      const [task] = insertBuilder.values.mock.calls[0] as [SupportTaskEntity];

      expect(task.livemode).toBe(false);
    });

    it('uses ON CONFLICT DO NOTHING with RETURNING', async () => {
      await service.open(manager, input);

      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(insertBuilder.returning).toHaveBeenCalledWith('id');
    });

    it('returns the new id when the insert took', async () => {
      await expect(service.open(manager, input)).resolves.toBe('sup_01HQ8ZZZ0000000000000009');
    });

    describe('when the same source event is redelivered', () => {
      beforeEach(() => {
        insertBuilder.execute.mockResolvedValue({ raw: [] });
      });

      it('returns the EXISTING task id, not the one it just minted', async () => {
        repositoryFindOne.mockResolvedValue({ id: 'sup_already_there' });

        // Logging an id that is not in the table cost two people an hour on 2026-04-28.
        await expect(service.open(manager, input)).resolves.toBe('sup_already_there');
      });

      it('looks the existing task up by kind and source event', async () => {
        repositoryFindOne.mockResolvedValue({ id: 'sup_already_there' });

        await service.open(manager, input);

        expect(repositoryFindOne).toHaveBeenCalledWith({
          where: { kind: 'duplicate_settlement', sourceEventId: 'evt_01HQ8ZZZ0000000000000003' },
        });
      });

      it('logs the suppression rather than the creation', async () => {
        const info = jest.spyOn(logger, 'info');
        repositoryFindOne.mockResolvedValue({ id: 'sup_already_there' });

        await service.open(manager, input);

        expect(info).toHaveBeenCalledWith('support_task.duplicate_suppressed', expect.anything());
      });

      it('falls back to the minted id when there is no source event to look up by', async () => {
        await expect(
          service.open(manager, { ...input, sourceEventId: null }),
        ).resolves.toBe('sup_01HQ8ZZZ0000000000000009');
      });
    });
  });

  describe('openStandalone', () => {
    it('wraps open() in its own transaction for callers with no ambient one', async () => {
      await service.openStandalone(input);

      // POST /internal/v1/support-tasks and the legacy biller's DunningService.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(insertBuilder.execute).toHaveBeenCalled();
    });
  });

  describe('listOpenForMerchant', () => {
    it('filters to open and acknowledged tasks for that merchant', async () => {
      await service.listOpenForMerchant(MERCHANT);

      expect(selectBuilder.where).toHaveBeenCalledWith('support_task.merchant_id = :merchantId', {
        merchantId: MERCHANT,
      });
      expect(selectBuilder.andWhere).toHaveBeenCalledWith(
        "support_task.status in ('open', 'acknowledged')",
      );
    });

    it('defaults to 50 rows', async () => {
      await service.listOpenForMerchant(MERCHANT);

      expect(selectBuilder.take).toHaveBeenCalledWith(50);
    });

    it('honours an explicit limit', async () => {
      await service.listOpenForMerchant(MERCHANT, 5);

      expect(selectBuilder.take).toHaveBeenCalledWith(5);
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

  describe('the admin back office (RFC platform-v2 §1)', () => {
    function taskRow(overrides: Partial<SupportTaskEntity> = {}): SupportTaskEntity {
      const task = new SupportTaskEntity();
      Object.assign(task, {
        id: 'sup_1',
        merchantId: MERCHANT,
        livemode: true,
        kind: 'duplicate_settlement',
        severity: 'high',
        status: 'open',
        chargeId: CHARGE,
        title: 'Possible double charge',
        body: 'facts',
        sourceEventId: null,
        assignedTo: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      });
      return task;
    }

    it('lists every merchant\'s tasks as the contract shape, filtered', async () => {
      selectBuilder.getMany.mockResolvedValue([taskRow()]);

      const page = await service.listForStaff(
        { status: 'open', kind: 'duplicate_settlement', merchantId: MERCHANT },
        { limit: 25, cursor: null, createdAfter: null, createdBefore: null },
      );

      expect(selectBuilder.andWhere).toHaveBeenCalledWith('support_task.status = :status', { status: 'open' });
      expect(selectBuilder.andWhere).toHaveBeenCalledWith('support_task.merchant_id = :merchantId', { merchantId: MERCHANT });
      expect(page.data[0]).toMatchObject({
        id: 'sup_1',
        object: 'support_task',
        body: 'facts',
        resolved_at: null,
        created_at: NOW.toISOString(),
      });
    });

    it('resolves an open task and answers the resolved row', async () => {
      repositoryFindOne
        .mockResolvedValueOnce(taskRow())
        .mockResolvedValueOnce(taskRow({ status: 'resolved', resolvedAt: NOW, resolutionNote: 'refunded', assignedTo: 'stf_1' }));

      const task = await service.resolveForStaff('sup_1', 'refunded', 'stf_1');

      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: 'resolved',
        resolvedAt: NOW,
        resolutionNote: 'refunded',
        assignedTo: 'stf_1',
      });
      expect(task).toMatchObject({ status: 'resolved', resolution_note: 'refunded', assigned_to: 'stf_1' });
    });

    it('404s an unknown task', async () => {
      repositoryFindOne.mockResolvedValue(null);

      await expect(service.resolveForStaff('sup_nope', null, 'stf_1')).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('409s a task that is already closed', async () => {
      repositoryFindOne.mockResolvedValue(taskRow({ status: 'dismissed' }));
      updateBuilder.execute.mockResolvedValue({ affected: 0 });

      await expect(service.resolveForStaff('sup_1', null, 'stf_1')).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
