/**
 * HttpExceptionFilter — the ONLY place anything becomes an HTTP response.
 *
 * One branch per row of api-surface.md §1.4, and a default that maps anything unrecognised to
 * `500 internal_error`. A raw `throw new HttpException` anywhere else in the repo is a review
 * rejection; `.eslintrc.cjs` bans the import outside this file, with an override here so the
 * filter can still catch Nest's own 404 for an unmatched route.
 *
 * Two behaviours worth knowing before you change anything:
 *
 *   `LedgerRejectedException` passes the LEDGER'S status and code through verbatim. A
