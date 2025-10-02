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

    it('produces different cursors for different rows', () => {
      expect(encodeCursor(cursor)).not.toBe(
        encodeCursor({ ...cursor, id: nextId('ch_') }),
      );
    });
  });

  describe('encodeFrom', () => {
    it('rejects a cursor that is not base64-decodable JSON', () => {
      expect(() => decodeCursor('not-a-cursor-at-all')).toThrow(ValidationException);
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
  });
});
