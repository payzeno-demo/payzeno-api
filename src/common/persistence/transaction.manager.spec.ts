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

});
