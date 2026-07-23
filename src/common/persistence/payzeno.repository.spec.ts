import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';

import type { MerchantScope } from 'src/common/base/merchant-scoped.entity';
import { ConflictException } from 'src/common/errors/api.exception';
import { PayzenoRepository } from 'src/common/persistence/payzeno.repository';
import { SQLSTATE } from 'src/common/persistence/typeorm-error.mapper';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * `PayzenoRepository<T>` — the layer that makes persistence a layer instead of
 * `repo.find()`. Twelve entity repositories extend it.
 *
 * Its whole reason to exist is that `scopedQuery` is the ONLY entry point, so no feature
 * repository can accidentally write an unscoped read. Everything below asserts that
 * property from the outside: whatever the caller asks for, the merchant and livemode
 * predicates are always applied first.
 */

interface Row {
  id: string;
  created_at: Date;
  createdAt: Date;
  merchant_id: string;
}

/** Records every predicate the repository builds, without a database. */
function recordingQueryBuilder() {
  const wheres: Array<[string, unknown]> = [];
  const orders: Array<[string, string]> = [];
  const state = {
    wheres,
    orders,
    locks: [] as string[],
    taken: 0,
    setValues: null as unknown,
    executed: false,
    affected: 1,
    error: null as Error | null,
  };

  const qb: Record<string, unknown> = {
    where: (sql: string, params?: unknown) => {
      wheres.push([sql, params]);
      return qb;
    },
    andWhere: (sql: string, params?: unknown) => {
      wheres.push([String(sql), params]);
      return qb;
    },
    orderBy: (column: string, direction: string) => {
      orders.push([column, direction]);
      return qb;
    },
    addOrderBy: (column: string, direction: string) => {
      orders.push([column, direction]);
      return qb;
    },
    take: (n: number) => {
      state.taken = n;
      return qb;
    },
    setLock: (mode: string) => {
      state.locks.push(mode);
      return qb;
    },
    update: () => qb,
    set: (values: unknown) => {
      state.setValues = values;
      return qb;
    },
    getOne: async () => ({ id: TEST_CHARGE_ID }),
    getCount: async () => 1,
    getMany: async () => [],
    execute: async () => {
      state.executed = true;
      if (state.error) throw state.error;
      return { affected: state.affected };
    },
  };

  return { qb: qb as unknown as SelectQueryBuilder<Row>, state };
}

class TestRepository extends PayzenoRepository<Row> {
  constructor(dataSource: DataSource) {
    super({} as never, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'charge';
  }
}

describe('PayzenoRepository', () => {
  let builder: ReturnType<typeof recordingQueryBuilder>;
  let repo: TestRepository;

  const scope: MerchantScope = { merchantId: TEST_MERCHANT_ID, livemode: true };

  beforeEach(() => {
    builder = recordingQueryBuilder();
    const dataSource = { createEntityManager: () => ({}) } as unknown as DataSource;
    repo = new TestRepository(dataSource);
    jest.spyOn(repo, 'createQueryBuilder').mockReturnValue(builder.qb);
    Object.defineProperty(repo, 'target', { value: 'ChargeEntity' });
  });

  describe('scopedQuery', () => {
    it('applies the merchant predicate first', () => {
      repo.scopedQuery(scope);

      expect(builder.state.wheres[0][0]).toContain('charge.merchant_id = :merchantId');
      expect(builder.state.wheres[0][1]).toEqual({ merchantId: TEST_MERCHANT_ID });
    });

    it('applies the livemode predicate too', () => {
      repo.scopedQuery(scope);

      expect(builder.state.wheres[1][0]).toContain('charge.livemode = :livemode');
      expect(builder.state.wheres[1][1]).toEqual({ livemode: true });
    });

    it('scopes test mode separately from live', () => {
      repo.scopedQuery({ merchantId: TEST_MERCHANT_ID, livemode: false });

      expect(builder.state.wheres[1][1]).toEqual({ livemode: false });
    });

    it('uses the subclass alias throughout', () => {
      repo.scopedQuery(scope);

      for (const [sql] of builder.state.wheres) {
        expect(sql).toContain('charge.');
      }
    });
  });

  describe('findScoped', () => {
    it('adds the id predicate on top of the scope, never instead of it', async () => {
      await repo.findScoped(TEST_CHARGE_ID, scope);

      expect(builder.state.wheres).toHaveLength(3);
      expect(builder.state.wheres[2][0]).toContain('charge.id = :id');
    });

    it('returns null rather than throwing, so the service picks the 404 subclass', async () => {
      (builder.qb as unknown as { getOne: () => Promise<unknown> }).getOne = async () => null;

      await expect(repo.findScoped(TEST_CHARGE_ID, scope)).resolves.toBeNull();
    });
  });

  describe('existsScoped', () => {
    it('counts within the scope', async () => {
      await expect(repo.existsScoped(TEST_CHARGE_ID, scope)).resolves.toBe(true);
    });

    it('is false when the count is zero', async () => {
      (builder.qb as unknown as { getCount: () => Promise<number> }).getCount = async () => 0;

      await expect(repo.existsScoped(TEST_CHARGE_ID, scope)).resolves.toBe(false);
    });
  });

  describe('paginateCursor', () => {
    it('orders by created_at then id, descending', async () => {
      await repo.paginateCursor(scope, { limit: 25, cursor: null } as never);

      expect(builder.state.orders).toEqual([
        ['charge.created_at', 'DESC'],
        ['charge.id', 'DESC'],
      ]);
    });

    it('takes limit + 1 so has_more needs no COUNT', async () => {
      await repo.paginateCursor(scope, { limit: 25, cursor: null } as never);

      expect(builder.state.taken).toBe(26);
    });

    it('applies created_after and created_before when supplied', async () => {
      await repo.paginateCursor(scope, {
        limit: 25,
        cursor: null,
        createdAfter: new Date('2026-01-01T00:00:00Z'),
        createdBefore: new Date('2026-02-01T00:00:00Z'),
      } as never);

      const sql = builder.state.wheres.map(([s]) => s).join(' ');
      expect(sql).toContain('charge.created_at > :createdAfter');
      expect(sql).toContain('charge.created_at < :createdBefore');
    });

    it('lets a caller extend the scoped builder without escaping the scope', async () => {
      const extend = jest.fn((qb: SelectQueryBuilder<Row>) => qb);

      await repo.paginateCursor(scope, { limit: 10, cursor: null } as never, extend);

      expect(extend).toHaveBeenCalledWith(builder.qb);
      expect(builder.state.wheres[0][0]).toContain('merchant_id');
    });

    it('returns a Paginated envelope', async () => {
      const page = await repo.paginateCursor(scope, { limit: 10, cursor: null } as never);

      expect(page).toEqual({ data: [], has_more: false, next_cursor: null });
    });
  });

  describe('lockForUpdate', () => {
    it('takes a pessimistic write lock', async () => {
      const manager = {
        getRepository: () => ({ createQueryBuilder: () => builder.qb }),
      } as unknown as EntityManager;

      await repo.lockForUpdate(TEST_CHARGE_ID, manager);

      expect(builder.state.locks).toContain('pessimistic_write');
    });

    it('requires a manager — a FOR UPDATE outside a transaction protects nothing', () => {
      // The signature makes it impossible to call without one; this asserts the intent
      // survives a refactor that tries to make it optional.
      expect(repo.lockForUpdate.length).toBe(2);
    });
  });

  describe('updateScoped', () => {
    function managerWithBuilder(): EntityManager {
      return {
        getRepository: () => ({ createQueryBuilder: () => builder.qb }),
      } as unknown as EntityManager;
    }

    it('constrains the update to the id, the merchant and the mode', async () => {
      await repo.updateScoped(TEST_CHARGE_ID, scope, { status: 'captured' } as never, undefined, managerWithBuilder());

      const sql = builder.state.wheres.map(([s]) => s).join(' ');
      expect(sql).toContain('id = :id');
      expect(sql).toContain('merchant_id = :merchantId');
      expect(sql).toContain('livemode = :livemode');
    });

    it('returns the number of rows affected', async () => {
      await expect(
        repo.updateScoped(TEST_CHARGE_ID, scope, { status: 'captured' } as never, undefined, managerWithBuilder()),
      ).resolves.toBe(1);
    });

    it('returns 0 when the predicate no longer holds — somebody got there first', async () => {
      builder.state.affected = 0;

      await expect(
        repo.updateScoped(TEST_CHARGE_ID, scope, { status: 'captured' } as never, undefined, managerWithBuilder()),
      ).resolves.toBe(0);
    });

    it('maps a unique violation through the error mapper', async () => {
      builder.state.error = Object.assign(new Error('duplicate key'), {
        code: SQLSTATE.UNIQUE_VIOLATION,
      });

      await expect(
        repo.updateScoped(TEST_CHARGE_ID, scope, {} as never, undefined, managerWithBuilder()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
