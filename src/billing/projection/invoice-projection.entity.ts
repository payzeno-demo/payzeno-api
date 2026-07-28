/**
 * `invoice_projection` — migration 20 (nmigration, month 12), data-model.md §1.16.
 *
 * The ONE projection in payzeno-api, and it is a read cache of **payzeno-billing-legacy**, not
 * of the ledger (interfaces.md §2.6). It exists so `GET /v1/invoices` stops fanning out to the
 * Java service on every request.
 *
 * When `ledger_owns_invoices` flips, the writer changes from `InvoiceProjectionConsumer`
 * (fed by `invoice.issued`) to `LedgerHttpClient`. Nothing else about this table changes. That
 * swap is the unfinished part of arc MIG at demo time.
 *
 * `source_occurred_at` is not decoration: the bus does not guarantee ordering, so every write
 * is a conditional upsert that refuses to let an older event overwrite a newer row
 * (events.ts, "Projection write rule").
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { CurrencyCode, InvoiceLine, InvoiceStatus, MerchantId } from '@payzeno/contracts';

import { BaseEntity } from '../../common/base/base.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../../common/typeorm/minor-units.transformer';

@Entity({ name: 'invoice_projection' })
@Index('ix_invoice_projection_merchant_period', ['merchant_id', 'period_start'])
@Index('ix_invoice_projection_status', ['merchant_id', 'status'])
export class InvoiceProjectionEntity extends BaseEntity {
  /** The legacy service's `inv_` id. This projection does not mint ids. */
  @PrimaryColumn({ type: 'text' })
  declare id: string;

  @Column({ type: 'text' })
  merchant_id: MerchantId;

  @Column({ type: 'text', nullable: true })
  subscription_id: string | null;

  @Column({ type: 'text' })
  number: string;

  @Column({ type: 'text' })
  status: InvoiceStatus;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  subtotal_minor: number;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  tax_minor: number;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  total_minor: number;

  @Column({ type: 'bigint', default: 0, transformer: requiredMinorUnitsTransformer })
  amount_paid_minor: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  lines: InvoiceLine[];

  @Column({ type: 'date' })
  period_start: string;

  @Column({ type: 'date' })
  period_end: string;

  @Column({ type: 'timestamptz', nullable: true })
  due_at: Date | null;

  /** True once the ledger owns generation for this merchant (arc MIG step 4). */
  @Column({ type: 'boolean', default: false })
  migrated_to_ledger: boolean;

  /**
   * `EventEnvelope.occurred_at` of the event that produced this row. The upsert's WHERE clause
   * compares against it — a redelivered older `invoice.issued` must not resurrect a stale
   * status over a newer one.
   */
  @Column({ type: 'timestamptz' })
  source_occurred_at: Date;

  /** Which mechanism last wrote the row. Flips to `ledger` when the cutover happens. */
  @Column({ type: 'text', default: 'billing_legacy' })
  source: 'billing_legacy' | 'ledger';

  @Column({ type: 'timestamptz' })
  refreshed_at: Date;
}
