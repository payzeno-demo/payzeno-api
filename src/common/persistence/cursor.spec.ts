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

    beforeEach(() => {
      qb = {
        andWhere: jest.fn(function chain() {
          return qb;
        }),
        orderBy: jest.fn(function chain() {
          return qb;
        }),
        addOrderBy: jest.fn(function chain() {
          return qb;
        }),
        take: jest.fn(function chain() {
          return qb;
        }),
        skip: jest.fn(),
        offset: jest.fn(),
      };
    });

    function apply(cursor: string | null, direction?: 'ASC' | 'DESC') {
      return applyCursor(qb as unknown as SelectQueryBuilder<CursorRow>, {
        limit: 25,
        cursor,
        alias: 'charge',
        direction,
      });
    }

    it('orders by created_at then id', () => {
      apply(null);

      expect(qb.orderBy).toHaveBeenCalledWith('charge.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('charge.id', 'DESC');
    });

    it('takes limit + 1, so has_more needs no COUNT', () => {
      apply(null);

      expect(qb.take).toHaveBeenCalledWith(26);
    });

    it('adds no predicate on the first page', () => {
      apply(null);

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('never issues an OFFSET or a skip', () => {
      apply(encodeCursor({ createdAt: '2026-01-15T12:00:00.000Z', id: TEST_CHARGE_ID }));

      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.offset).not.toHaveBeenCalled();
    });

    it('adds the row-value comparison when a cursor is supplied', () => {
      apply(encodeCursor({ createdAt: '2026-01-15T12:00:00.000Z', id: TEST_CHARGE_ID }));

      const [sql, params] = qb.andWhere.mock.calls[0];
      expect(sql).toContain('charge.created_at <');
      expect(sql).toContain('charge.id <');
      expect(params).toMatchObject({ cursorId: TEST_CHARGE_ID });
      expect(params.cursorCreatedAt).toBeInstanceOf(Date);
    });

    it('breaks ties on id within the same instant', () => {
      // Two rows created in the same millisecond are ordinary at our volume, and offset
      // pagination silently skips one of them.
      apply(encodeCursor({ createdAt: '2026-01-15T12:00:00.000Z', id: TEST_CHARGE_ID }));

      expect(qb.andWhere.mock.calls[0][0]).toContain('charge.created_at = :cursorCreatedAt');
    });

    it('flips the comparison for an ascending page', () => {
      apply(encodeCursor({ createdAt: '2026-01-15T12:00:00.000Z', id: TEST_CHARGE_ID }), 'ASC');

      expect(qb.andWhere.mock.calls[0][0]).toContain('charge.created_at >');
      expect(qb.orderBy).toHaveBeenCalledWith('charge.created_at', 'ASC');
    });

    it('rejects a hand-edited cursor with a 422', () => {
      expect(() => apply('not-a-real-cursor')).toThrow(ValidationException);
    });
  });

  describe('toPage', () => {
    const rows = [
      row(nextId('ch_'), '2026-01-15T12:00:03.000Z'),
      row(nextId('ch_'), '2026-01-15T12:00:02.000Z'),
      row(nextId('ch_'), '2026-01-15T12:00:01.000Z'),
    ];

    it('reports has_more false and a null cursor for a short page', () => {
      const page = toPage(rows, 10);

      expect(page.data).toHaveLength(3);
      expect(page.has_more).toBe(false);
      expect(page.next_cursor).toBeNull();
    });

    it('trims the sentinel row when the page is full', () => {
      const page = toPage(rows, 2);

      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
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

    it('handles a page that is exactly the limit', () => {
      const page = toPage(rows.slice(0, 2), 2);

      expect(page.has_more).toBe(false);
      expect(page.next_cursor).toBeNull();
    });

    it('round-trips: the next cursor points at the row after the last returned one', () => {
      const first = toPage(rows, 2);
      const cursor = decodeCursor(first.next_cursor!);

      expect(new Date(cursor.createdAt).getTime()).toBeGreaterThan(rows[2].createdAt.getTime());
    });
  });

  describe('mapPage', () => {
    it('maps the rows and preserves the cursor metadata', () => {
      const page = { data: [row('ch_1', '2026-01-15T12:00:00Z')], has_more: true, next_cursor: 'abc' };

      const mapped = mapPage(page, (r) => ({ id: r.id.toUpperCase() }));

      expect(mapped).toEqual({ data: [{ id: 'CH_1' }], has_more: true, next_cursor: 'abc' });
    });

    it('handles an empty page', () => {
      expect(mapPage({ data: [], has_more: false, next_cursor: null }, () => 1)).toEqual({
        data: [],
        has_more: false,
        next_cursor: null,
      });
    });
  });
});
