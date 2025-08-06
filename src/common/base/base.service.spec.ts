import type { ListQuery, Paginated } from '@payzeno/contracts';

import { BaseService } from 'src/common/base/base.service';
import type { MerchantScope } from 'src/common/base/merchant-scoped.entity';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { ChargeNotFoundException } from 'src/common/errors/not-found.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { PayzenoRepository } from 'src/common/persistence/payzeno.repository';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The `INHERITS` root for eight services. Two protected helpers, and both of them exist
 * so that no feature service ever writes an unscoped read.
 *
 * `notFound()` is overridable on purpose: the default is correct but generic, and a
 * generic 404 is much harder to attribute when the graph is the thing you are reading.
 */

interface Row {
  id: string;
  created_at: Date;
  merchant_id: string;
}

class TestService extends BaseService<Row> {
  constructor(repo: PayzenoRepository<Row>) {
    super(repo, new NoopLogger());
  }

  get entityName(): string {
    return 'test_entity';
  }

  find(id: string, scope: MerchantScope): Promise<Row> {
    return this.findOneOrThrow(id, scope);
  }

  page(query: ListQuery, scope: MerchantScope): Promise<Paginated<Row>> {
    return this.paginate(query, scope);
  }

  pageWhere(query: ListQuery, scope: MerchantScope): Promise<Paginated<Row>> {
    return this.paginateWhere(query, scope, { merchant_id: scope.merchantId } as never);
  }
}

/** Overrides `notFound` the way `ChargesService` does. */
class ChargeLikeService extends TestService {
  override get entityName(): string {
    return 'charge';
  }

  protected override notFound(id: string): ResourceNotFoundException {
    return new ChargeNotFoundException(id);
  }
}

describe('BaseService', () => {
  let repo: jest.Mocked<PayzenoRepository<Row>>;
  let service: TestService;

  const scope: MerchantScope = { merchantId: TEST_MERCHANT_ID, livemode: true };
  const row: Row = { id: TEST_CHARGE_ID, created_at: new Date('2026-01-15T12:00:00Z'), merchant_id: TEST_MERCHANT_ID };

  beforeEach(() => {
    repo = {
      findScoped: jest.fn(),
      paginateCursor: jest.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false }),
    } as unknown as jest.Mocked<PayzenoRepository<Row>>;
    service = new TestService(repo);
  });

  it('requires a subclass to name its entity', () => {
    expect(service.entityName).toBe('test_entity');
  });

  describe('findOneOrThrow', () => {
    it('returns the row when it is in scope', async () => {
      repo.findScoped.mockResolvedValue(row);

      await expect(service.find(TEST_CHARGE_ID, scope)).resolves.toEqual(row);
    });

    it('always reads through findScoped — never an unscoped find', async () => {
      repo.findScoped.mockResolvedValue(row);

      await service.find(TEST_CHARGE_ID, scope);

      expect(repo.findScoped).toHaveBeenCalledWith(TEST_CHARGE_ID, scope);
    });

    it('throws ResourceNotFoundException when the row is not in scope', async () => {
      repo.findScoped.mockResolvedValue(null);

      await expect(service.find(TEST_CHARGE_ID, scope)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('names the entity in the thrown exception', async () => {
      repo.findScoped.mockResolvedValue(null);

      const err = await service.find(TEST_CHARGE_ID, scope).catch((e: Error) => e);

      expect(err.message).toContain('test_entity');
    });

    it('honours a subclass override of notFound()', async () => {
      const charges = new ChargeLikeService(repo);
      repo.findScoped.mockResolvedValue(null);

      await expect(charges.find(TEST_CHARGE_ID, scope)).rejects.toBeInstanceOf(
        ChargeNotFoundException,
      );
    });

    it('separates live and test mode within one merchant', async () => {
      repo.findScoped.mockResolvedValue(null);

      await service.find(TEST_CHARGE_ID, { merchantId: TEST_MERCHANT_ID, livemode: false }).catch(
        () => undefined,
      );

      expect(repo.findScoped).toHaveBeenCalledWith(
        TEST_CHARGE_ID,
        expect.objectContaining({ livemode: false }),
      );
    });
  });

  describe('paginate', () => {
    it('delegates to paginateCursor with the scope first', async () => {
      await service.page({ limit: 25 }, scope);

      expect(repo.paginateCursor).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({ limit: 25 }),
        undefined,
      );
    });

    it('resolves an absent limit to a default rather than passing undefined to SQL', async () => {
      await service.page({}, scope);

      const [, resolved] = repo.paginateCursor.mock.calls[0];
      expect(typeof (resolved as { limit: number }).limit).toBe('number');
      expect((resolved as { limit: number }).limit).toBeGreaterThan(0);
    });

    it('returns the repository’s page unchanged', async () => {
      const page = { data: [row], next_cursor: 'abc', has_more: true };
      repo.paginateCursor.mockResolvedValue(page);

      await expect(service.page({ limit: 1 }, scope)).resolves.toEqual(page);
    });

    it('carries created_after / created_before through', async () => {
      await service.page(
        { created_after: '2026-01-01T00:00:00.000Z', created_before: '2026-02-01T00:00:00.000Z' },
        scope,
      );

      const [, resolved] = repo.paginateCursor.mock.calls[0];
      expect(resolved).toMatchObject({
        createdAfter: expect.anything(),
        createdBefore: expect.anything(),
      });
    });
  });

  describe('paginateWhere', () => {
    it('passes an extend function through to the scoped builder', async () => {
      await service.pageWhere({ limit: 10 }, scope);

      const [, , extend] = repo.paginateCursor.mock.calls[0];
      expect(typeof extend).toBe('function');
    });

    it('still scopes the query — the predicate is additive, not a replacement', async () => {
      await service.pageWhere({ limit: 10 }, scope);

      expect(repo.paginateCursor).toHaveBeenCalledWith(scope, expect.anything(), expect.any(Function));
    });
  });
});
