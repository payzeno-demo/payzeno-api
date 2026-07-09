/**
 * TransactionManager — the transaction boundary for every multi-aggregate write.
 *
 * Two rules, both from docs/adr/0011-outbox-over-direct-publish.md:
 *
 *   1. The outbox write happens INSIDE the business transaction. `OutboxEventPublisher` takes
 *      the same EntityManager the caller is holding, so a rolled-back capture cannot leave a
 *      `payment.captured` event behind, and a committed capture cannot fail to emit one.
 *   2. READ COMMITTED, everywhere. We do not set an isolation level anywhere in this repo.
 *      A retry blocked on a row lock must re-evaluate its predicate against data the winner
 *      has since committed; under REPEATABLE READ the snapshot predates the lock wait and the
 *      re-read still sees the stale row. That is the correctness argument behind the ledger's
 *      PAY-2043 hotfix and it applies identically on this side.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { isSerializationFailure, mapTypeOrmError } from './typeorm-error.mapper';

/**
 * The in-flight EntityManager, so `OutboxEventPublisher.publish` can find the caller's
 * transaction without every business method threading a manager through its signature. That
 * is what makes "the outbox row is written inside the business transaction" (ADR 0011) true
 * by construction rather than by everyone remembering to pass an argument.
 */
const active = new AsyncLocalStorage<EntityManager>();

export interface TransactionOptions {
  /** Retries on 40001/40P01 only. Never on a business exception. */
  retries?: number;
  retryBaseDelayMs?: number;
}

@Injectable()
export class TransactionManager {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs `fn` in a transaction. If an EntityManager is already in flight the callback joins
   * it rather than opening a nested one — a nested transaction here would give the inner
   * block its own commit point and break rule 1 above.
   */
  async runInTransaction<T>(
    fn: (manager: EntityManager) => Promise<T>,
    existing?: EntityManager,
    options: TransactionOptions = {},
  ): Promise<T> {
    if (existing?.queryRunner?.isTransactionActive) {
      return fn(existing);
    }

    const retries = options.retries ?? 0;
    const baseDelay = options.retryBaseDelayMs ?? 25;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.dataSource.transaction((manager) => active.run(manager, () => fn(manager)));
      } catch (err) {
        if (attempt < retries && isSerializationFailure(err)) {
          await sleep(baseDelay * 2 ** attempt);
          continue;
        }
        throw mapTypeOrmError(err);
      }
    }
  }

  /** Read-only work that still wants a consistent view across several statements. */
  async runInReadTransaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return fn(manager);
    });
  }

  /** For the rare caller that needs a manager without opening a transaction (health checks). */
  get manager(): EntityManager {
    return this.dataSource.manager;
  }

  /**
   * The manager of the transaction we are inside, or the bare one when we are not.
   *
   * `OutboxEventPublisher` is the caller that matters: publishing outside a transaction is
   * legal (the `merchant.status_changed` emitted by a job has no business row to ride along
   * with) but publishing INSIDE one must join it.
   */
  currentManager(): EntityManager {
    return active.getStore() ?? this.dataSource.manager;
  }

  isInTransaction(): boolean {
    return active.getStore() !== undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
