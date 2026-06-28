/**
 * Every flag name in payzeno-api, in one place.
 *
 * Hot file: every arc adds one and (usually) fails to remove it. Read the comments — a couple
 * of these are load-bearing history rather than switches anybody should touch.
 */

export const FLAG_NAMES = {
  /**
   * arc MIG step 4. FALSE in production and it has been false for six months.
   * Flipping it moves `invoice_projection`'s writer from InvoiceProjectionConsumer /
   * BillingLegacyClient to LedgerHttpClient. The ledger arm of InvoiceSourceResolver
   * compiles and is covered by one spec; it has never been taken in production.
   * docs/adr/0012-invoice-cutover.md.
   */
  LEDGER_OWNS_INVOICES: 'ledger_owns_invoices',

  /** arc MIG step 1, done. True everywhere. Kept because the legacy fee path still compiles. */
  LEDGER_OWNS_FEES: 'ledger_owns_fees',
