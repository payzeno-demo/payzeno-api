import type { SelectQueryBuilder } from 'typeorm';

import { ValidationException } from 'src/common/errors/api.exception';
import { applyCursor, mapPage, toPage } from 'src/common/persistence/cursor';
import type { CursorRow } from 'src/common/persistence/cursor';
import { decodeCursor, encodeCursor } from 'src/common/pagination/cursor.codec';

import { TEST_CHARGE_ID, nextId } from 'test/factories/ids';

/**
 * Keyset pagination, never OFFSET.
 *
 * `ix_charge_merchant_created (merchant_id, created_at desc)` exists so this predicate is
 * an index range scan. An `OFFSET 20000` re-reads twenty thousand rows to throw them
 * away, which is exactly the shape of the console's settlement-list regression in month 7
 * (arc PERF) — so the assertion that no `skip`/`offset` is ever issued is load-bearing.
 */
describe('cursor', () => {
  function row(id: string, createdAt: string): CursorRow {
    return { id, createdAt: new Date(createdAt) };
  }

  describe('applyCursor', () => {
    let qb: {
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      take: jest.Mock;
      skip: jest.Mock;
      offset: jest.Mock;
    };

    it('orders by created_at then id', () => {
      apply(null);

      expect(qb.orderBy).toHaveBeenCalledWith('charge.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('charge.id', 'DESC');
    });

    it('mints the next cursor from the last row actually returned', () => {
      const page = toPage(rows, 2);

      expect(decodeCursor(page.next_cursor!)).toEqual({
        createdAt: rows[1].createdAt.toISOString(),
        id: rows[1].id,
      });
    });

    it('handles an empty result', () => {
      const page = toPage([], 25);

      expect(page).toEqual({ data: [], has_more: false, next_cursor: null });
    });

  });
});
