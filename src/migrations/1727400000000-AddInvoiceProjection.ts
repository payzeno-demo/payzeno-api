import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 20 — arc MIG step 4 groundwork. `invoice_projection`.
 *
 * A read cache of **payzeno-billing-legacy**, not of the ledger. `InvoicesService` currently
 * fans out to the Java service per request for any merchant not in this table; the projection
 * is what lets `GET /v1/invoices` answer without a synchronous hop into a system we are trying
 * to strangle. `InvoiceProjectionConsumer` refreshes it off `invoice.issued`.
 *
 * `source_occurred_at` is not decoration. Ordering is not guaranteed on the bus, so every
 * projection write is a conditional upsert:
 *
 *   insert ... on conflict (invoice_public_id) do update set ...
 *    where invoice_projection.source_occurred_at < excluded.source_occurred_at
 *
 * Without it a redelivered older `invoice.issued` silently reverts a paid invoice to open.
 *
 * When `ledger_owns_invoices` flips, the writer becomes `LedgerHttpClient` and nothing else
 * about this table changes. That flip has not happened. It is month 12 and the flag is still
 * false — see docs/adr/0012-invoice-cutover.md, and the disagreement in its PR thread.
 *
 * — nmigration, month 12
 */
export class AddInvoiceProjection1727400000000 implements MigrationInterface {
  name = 'AddInvoiceProjection1727400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table invoice_projection (
        invoice_public_id text primary key,
        merchant_id text not null,
        number text not null,
        status text not null,
        currency char(3) not null,
        subtotal_minor bigint not null,
        tax_minor bigint not null,
        total_minor bigint not null,
        amount_paid_minor bigint not null default 0,
        period_start date,
        period_end date,
        due_at timestamptz,
        migrated_to_ledger boolean not null default false,
        livemode boolean not null default true,
        source_event_id text not null,
        source_occurred_at timestamptz not null,
        updated_at timestamptz not null default now()
      )
    `);

    await queryRunner.query(`
      create index ix_invoice_projection_merchant
        on invoice_projection (merchant_id, period_start desc)
    `);
    await queryRunner.query(`
      create unique index uq_invoice_projection_number on invoice_projection (merchant_id, number)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists invoice_projection`);
  }
}
