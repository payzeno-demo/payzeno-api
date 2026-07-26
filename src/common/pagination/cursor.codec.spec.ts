import { ValidationException } from 'src/common/errors/api.exception';
import {
  decodeCursor,
  decodeOptionalCursor,
  encodeCursor,
  encodeFrom,
} from 'src/common/pagination/cursor.codec';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID, nextId } from 'test/factories/ids';

/**
 * Yonatan's first change outside his own feature. Omer asked for the spec before the
 * code, which is why this file is longer than the module it covers — and why the
 * hand-edited-cursor cases exist at all: a bad cursor has to be a 422, never a 500 and
 * never a SQL error.
 */
describe('cursor.codec', () => {
  const cursor = { createdAt: '2026-01-15T12:00:00.000Z', id: TEST_CHARGE_ID };

  describe('encodeCursor', () => {
    it('produces a base64url string with no padding or url-unsafe characters', () => {
      const encoded = encodeCursor(cursor);

      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded).not.toContain('=');
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
    });

    it('is deterministic for the same input', () => {
      expect(encodeCursor(cursor)).toBe(encodeCursor({ ...cursor }));
    });

    it('produces different cursors for different rows', () => {
      expect(encodeCursor(cursor)).not.toBe(
        encodeCursor({ ...cursor, id: nextId('ch_') }),
      );
    });
  });

  describe('encodeFrom', () => {
    it('accepts a row with a Date and normalises it to RFC 3339', () => {
      const encoded = encodeFrom({
        createdAt: new Date('2026-01-15T12:00:00.000Z'),
        id: TEST_CHARGE_ID,
      });

      expect(decodeCursor(encoded)).toEqual(cursor);
    });
  });

  describe('decodeCursor', () => {
    it('round-trips an encoded cursor', () => {
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it('rejects a cursor that is not base64-decodable JSON', () => {
      expect(() => decodeCursor('not-a-cursor-at-all')).toThrow(ValidationException);
    });

    it('rejects a cursor whose payload is not an object', () => {
      const encoded = Buffer.from('"just a string"', 'utf8').toString('base64url');

      expect(() => decodeCursor(encoded)).toThrow(ValidationException);
    });

    it('rejects a cursor with a non-instant timestamp', () => {
      const encoded = Buffer.from(
        JSON.stringify({ c: 'yesterday-ish', i: TEST_CHARGE_ID }),
        'utf8',
      ).toString('base64url');

      expect(() => decodeCursor(encoded)).toThrow(ValidationException);
    });

    it('rejects an over-long cursor before attempting to decode it', () => {
      expect(() => decodeCursor('A'.repeat(4_096))).toThrow(ValidationException);
    });

    it('reports the failure against the `cursor` field so the console can point at it', () => {
      try {
        decodeCursor('garbage');
        throw new Error('expected a ValidationException');
      } catch (err) {
        const fieldErrors = (err as ValidationException).fieldErrors ?? [];
        expect(fieldErrors[0]).toMatchObject({ path: 'cursor', code: 'invalid_cursor' });
      }
    });

    it('never throws a raw Error — every failure is a 422', () => {
      for (const bad of ['', 'x', '!!!!', Buffer.from('{}').toString('base64url')]) {
        expect(() => decodeCursor(bad)).toThrow(ValidationException);
      }
    });
  });

  describe('decodeOptionalCursor', () => {
    it('returns null for undefined — the first page is not an error', () => {
      expect(decodeOptionalCursor(undefined)).toBeNull();
    });

    it('returns null for null and for an empty string', () => {
      expect(decodeOptionalCursor(null)).toBeNull();
      expect(decodeOptionalCursor('')).toBeNull();
    });

    it('still validates a cursor that is present', () => {
      expect(() => decodeOptionalCursor('garbage')).toThrow(ValidationException);
    });

    it('decodes a valid cursor', () => {
      expect(decodeOptionalCursor(encodeCursor(cursor))).toEqual(cursor);
    });
  });
});
