/**
 * Opaque cursor encoding for `Paginated<T>.next_cursor`.
 *
 * A cursor is a base64url of `{created_at, id}` — the tuple every list index in
 * data-model.md orders on (`ix_*_merchant_created (merchant_id, created_at desc)` plus the id
 * as a tiebreaker, because two rows created in the same millisecond are ordinary at our
 * volume and offset pagination silently skips one of them).
 *
 * It is deliberately NOT a signed token. The contents are a timestamp and a public id the
 * caller already has, and signing it would mean rotating a key breaks every open list page in
 * the console. It IS validated on the way in, because a hand-edited cursor must produce a 422
 * and not a SQL error.
 *
 * (ystackoverflow's first change outside his own feature — osquash asked for the spec before
 * the code, which is why cursor.codec.spec.ts exists and is longer than the file.)
 */
import { ValidationException } from '../errors/api.exception';
