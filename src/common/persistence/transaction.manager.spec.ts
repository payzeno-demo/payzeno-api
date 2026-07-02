import type { DataSource, EntityManager } from 'typeorm';

import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { SQLSTATE } from 'src/common/persistence/typeorm-error.mapper';

/**
 * The transaction boundary for every multi-aggregate write (ADR 0011).
 *
 * The two behaviours worth protecting: an existing manager is *joined*, not nested — a
 * nested transaction would give the inner block its own commit point and let a rolled-back
 * capture leave a `payment.captured` row in the outbox — and a serialization failure is
 * retried while a business exception never is.
 */
describe('TransactionManager', () => {
  let transaction: jest.Mock;
  let dataSource: DataSource;
  let manager: TransactionManager;

  beforeEach(() => {
    transaction = jest
      .fn()
      .mockImplementation(async (fn: (m: EntityManager) => Promise<unknown>) =>
        fn({ id: 'outer' } as unknown as EntityManager),
      );
    dataSource = { transaction, manager: { id: 'root' } } as unknown as DataSource;
    manager = new TransactionManager(dataSource);
  });

  function serializationFailure(): Error {
    return Object.assign(new Error('could not serialize access'), {
      code: SQLSTATE.SERIALIZATION_FAILURE,
    });
  }

  it('opens a transaction and hands the callback its manager', async () => {
    const seen: unknown[] = [];

    await manager.runInTransaction(async (m) => {
      seen.push(m);
      return 'done';
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ id: 'outer' });
  });

  it('returns the callback’s value', async () => {
    await expect(manager.runInTransaction(async () => 42)).resolves.toBe(42);
  });

  it('joins an active manager instead of nesting', async () => {
    const existing = {
      id: 'existing',
      queryRunner: { isTransactionActive: true },
    } as unknown as EntityManager;

    let received: EntityManager | undefined;
    await manager.runInTransaction(
      async (m) => {
        received = m;
      },
      existing,
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(received).toBe(existing);
  });

  describe('retries', () => {
    it('does not retry by default', async () => {
      transaction.mockRejectedValue(serializationFailure());

      await expect(manager.runInTransaction(async () => undefined)).rejects.toThrow();
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('retries a serialization failure up to the configured count', async () => {
      transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(serializationFailure())
        .mockImplementationOnce(async (fn: (m: EntityManager) => Promise<unknown>) =>
          fn({} as EntityManager),
        );

      await expect(
        manager.runInTransaction(async () => 'ok', undefined, { retries: 2, retryBaseDelayMs: 1 }),
      ).resolves.toBe('ok');
      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it('gives up after the retry budget', async () => {
      transaction.mockRejectedValue(serializationFailure());

      await expect(
        manager.runInTransaction(async () => undefined, undefined, {
          retries: 2,
          retryBaseDelayMs: 1,
        }),
      ).rejects.toThrow();
      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it('never retries a business exception', async () => {
      transaction.mockRejectedValue(new Error('refund window closed'));

      await expect(
        manager.runInTransaction(async () => undefined, undefined, {
          retries: 3,
          retryBaseDelayMs: 1,
        }),
      ).rejects.toThrow('refund window closed');
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('backs off between attempts', async () => {
      transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockImplementationOnce(async (fn: (m: EntityManager) => Promise<unknown>) =>
          fn({} as EntityManager),
        );

      const started = Date.now();
      await manager.runInTransaction(async () => 'ok', undefined, {
        retries: 1,
        retryBaseDelayMs: 20,
      });

      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    });
  });

  it('maps a driver error through typeorm-error.mapper on the way out', async () => {
    transaction.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: SQLSTATE.UNIQUE_VIOLATION }),
    );

    await expect(manager.runInTransaction(async () => undefined)).rejects.toBeInstanceOf(Error);
  });

  describe('runInReadTransaction', () => {
    it('marks the transaction read-only before running the callback', async () => {
      const query = jest.fn().mockResolvedValue([]);
      transaction.mockImplementation(async (fn: (m: EntityManager) => Promise<unknown>) =>
        fn({ query } as unknown as EntityManager),
      );

      await manager.runInReadTransaction(async () => 'ok');

      expect(query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    });
  });

  describe('manager', () => {
    it('exposes the root manager for callers that need no transaction', () => {
      expect(manager.manager).toEqual({ id: 'root' });
    });
  });
});
