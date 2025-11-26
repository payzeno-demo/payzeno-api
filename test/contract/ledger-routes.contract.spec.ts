import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LedgerHttpClient } from 'src/ledger/ledger-http.client';

/**
 * Cross-repo contract test (tests.md §4).
 *
 * payzeno-ledger's `tests/api/test_openapi_snapshot.py` asserts its generated OpenAPI
 * matches `contracts/ledger-openapi.json`. This file asserts the other half: every route
 * `LedgerHttpClient` calls is described by that same document.
 *
 * The pair is what makes a ledger route rename fail in CI instead of at 03:00. Neither
 * half is sufficient alone — the ledger's snapshot test passes happily while payzeno-api
 * calls a path that was deleted two releases ago.
 *
 * The route table below is api-surface.md §11, verbatim. It is duplicated here on
 * purpose: if it were derived from `LedgerHttpClient`'s source the test would agree with
 * whatever the client currently does, which is the opposite of a contract.
 */

interface OpenApiDocument {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components?: { schemas?: Record<string, unknown> };
}

const OPENAPI_PATH = join(__dirname, '..', '..', 'contracts', 'ledger-openapi.json');

const openapi: OpenApiDocument = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));

/** `method` is a real key of `LedgerHttpClient`; `path` is the ledger's OpenAPI template. */
const LEDGER_ROUTES: ReadonlyArray<{
  method: keyof LedgerHttpClient;
  verb: 'get' | 'post';
  path: string;
}> = [
  { method: 'bootstrapAccounts', verb: 'post', path: '/internal/v1/accounts/bootstrap' },
  { method: 'getBalance', verb: 'get', path: '/internal/v1/balances/{merchant_id}' },
  { method: 'getBalanceHistory', verb: 'get', path: '/internal/v1/balances/{merchant_id}/history' },
  { method: 'postTransaction', verb: 'post', path: '/internal/v1/transactions' },
  { method: 'listTransactions', verb: 'get', path: '/internal/v1/transactions' },
  {
    method: 'reverseTransaction',
    verb: 'post',
    path: '/internal/v1/transactions/{transaction_id}/reverse',
  },
  { method: 'listSettlementBatches', verb: 'get', path: '/internal/v1/settlement-batches' },
  { method: 'getSettlementBatch', verb: 'get', path: '/internal/v1/settlement-batches/{batch_id}' },
  {
    method: 'listSettlementItems',
    verb: 'get',
    path: '/internal/v1/settlement-batches/{batch_id}/items',
  },
  {
    method: 'retryReconciliationItem',
    verb: 'post',
    path: '/internal/v1/reconciliation/items/{item_id}/retry',
  },
  { method: 'listPayouts', verb: 'get', path: '/internal/v1/payouts' },
  { method: 'getPayout', verb: 'get', path: '/internal/v1/payouts/{payout_id}' },
  { method: 'createPayout', verb: 'post', path: '/internal/v1/payouts' },
  { method: 'cancelPayout', verb: 'post', path: '/internal/v1/payouts/{payout_id}/cancel' },
];

describe('LedgerHttpClient ↔ payzeno-ledger OpenAPI contract', () => {
  it('declares all fourteen routes of api-surface.md §11', () => {
    expect(LEDGER_ROUTES).toHaveLength(14);
  });

  describe.each(LEDGER_ROUTES)('$method → $verb $path', ({ method, verb, path }) => {
    it('exists as a method on LedgerHttpClient', () => {
      const impl = (LedgerHttpClient.prototype as unknown as Record<string, unknown>)[
        method as string
      ];
      expect(typeof impl).toBe('function');
    });

    const undescribed = LEDGER_ROUTES.filter((r) => !described.has(r.path)).map((r) => r.path);
    expect(undescribed).toEqual([]);
  });

  it('the ledger still publishes the shared ApiError envelope', () => {
    // LedgerRejectedException carries `code`/`httpStatus`/`details` verbatim out of this
    // schema. If the ledger stops emitting it, every non-2xx collapses into
    // LedgerUnavailableException and `settlement_locked` stops reaching the console.
    expect(openapi.components?.schemas?.ApiError).toBeDefined();
  });

  it('every LedgerHttpClient public method is covered by the table', () => {
    const declared = new Set<string>(LEDGER_ROUTES.map((r) => r.method as string));
    // Inherited BaseHttpClient members (`request`, `get`, `post`, …) are not ledger routes.
    const inherited = new Set(['request', 'get', 'post', 'patch', 'delete', 'buildUrl']);
    const uncovered = publicMethods.filter((m) => !declared.has(m) && !inherited.has(m));
    expect(uncovered).toEqual([]);
  });
});
