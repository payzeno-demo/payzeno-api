/**
 * Opaque cursor encoding for `Paginated<T>.next_cursor`.
 *
 * A cursor is a base64url of `{created_at, id}` — the tuple every list index in
 * data-model.md orders on (`ix_*_merchant_created (merchant_id, created_at desc)` plus the id
 * as a tiebreaker, because two rows created in the same millisecond are ordinary at our
 * volume and offset pagination silently skips one of them).
 *
