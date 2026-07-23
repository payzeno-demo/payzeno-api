import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 31 — `livemode` on the seven merchant-scoped tables that never got one.
 *
 * `merchant`, `payment_intent` and `charge` have carried `livemode` since migrations 01/02.
 * The tables added afterwards did not, because at the time every one of them was reachable
 * only through a parent row that did, and "you can always join to the parent" is true right
 * up until somebody writes `select * from webhook_event where next_attempt_at < now()` in a
 * job and delivers a test-mode event to a production endpoint. That happened twice.
 *
 * `MerchantScopedEntity` declares `livemode` for all nine entities, so the ORM has been
 * writing a column that only existed on two of them and TypeORM has been silently dropping
 * it on insert for the rest. This migration makes the schema agree with the base class.
 *
 * TWO-PHASE, deliberately. `add column ... not null default false` would be a metadata-only
 * change on PG11+, but the default is a lie for the ~40% of rows that belong to test-mode
 * parents, and rewriting them under an ACCESS EXCLUSIVE lock on `webhook_event` (78M rows)
 * is a multi-minute outage on the delivery path. So:
 *
 *   phase 1 (this migration)  add nullable, backfill in bounded batches from the parent row,
 *                             then add a NOT VALID check and VALIDATE it — VALIDATE takes
 *                             only SHARE UPDATE EXCLUSIVE and does not block writes.
 *   phase 2 (next release)    `set not null` using the already-validated constraint, which
 *                             PG16 accepts without a second full scan, and drop the check.
 *
 * The check constraint is the enforcement in the meantime: a null fails it, so nothing new
 * can arrive without a livemode even though the column is still nominally nullable.
 *
 * — dhotfix, month 12
 */
export class AddLivemodeToMerchantScoped1728900000000 implements MigrationInterface {
  name = 'AddLivemodeToMerchantScoped1728900000000';

  /** Batched backfills must commit as they go, so this runs outside typeorm's transaction. */
  transaction = false as const;

  /** Rows per backfill statement. Tuned so the slowest table stays under ~200ms per batch. */
  private static readonly BATCH_SIZE = 20_000;

  /**
   * Each entry is `[table, the expression that derives livemode from its parent]`.
   * Ordered parent-first: `webhook_event` reads `webhook_endpoint`, which must be filled in
   * before it is read from.
   */
  private static readonly BACKFILLS: ReadonlyArray<[string, string]> = [
    ['api_key', `(select m.livemode from merchant m where m.id = t.merchant_id)`],
    ['bank_account', `(select m.livemode from merchant m where m.id = t.merchant_id)`],
    ['webhook_endpoint', `(select m.livemode from merchant m where m.id = t.merchant_id)`],
    ['audit_log', `(select m.livemode from merchant m where m.id = t.merchant_id)`],
    ['refund', `(select c.livemode from charge c where c.id = t.charge_id)`],
    ['dispute', `(select c.livemode from charge c where c.id = t.charge_id)`],
    [
      'webhook_event',
      `(select e.livemode from webhook_endpoint e where e.id = t.endpoint_id)`,
    ],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table] of AddLivemodeToMerchantScoped1728900000000.BACKFILLS) {
      await queryRunner.query(`alter table ${table} add column if not exists livemode boolean`);
    }

    for (const [table, parentExpr] of AddLivemodeToMerchantScoped1728900000000.BACKFILLS) {
      await this.backfill(queryRunner, table, parentExpr);
    }

    // `api_key.livemode` is derivable from the token prefix too, and the two disagree for
    // eleven rows created by the month-3 seeding script. The prefix is what the resolver
    // actually keys on, so it wins.
    await queryRunner.query(`
      update api_key set livemode = (prefix = 'sk_live')
      where livemode is distinct from (prefix = 'sk_live')
    `);

    for (const [table] of AddLivemodeToMerchantScoped1728900000000.BACKFILLS) {
      // Orphans: rows whose parent was hard-deleted before we had ON DELETE RESTRICT
      // everywhere. There are 3 in `audit_log`. Test mode is the safe assumption — a
      // livemode row that is wrongly false is invisible, one that is wrongly true is a
      // production leak.
      await queryRunner.query(`update ${table} set livemode = false where livemode is null`);

      await queryRunner.query(`
        alter table ${table}
          add constraint chk_${table}_livemode_present check (livemode is not null) not valid
      `);
      await queryRunner.query(
        `alter table ${table} validate constraint chk_${table}_livemode_present`,
      );
      await queryRunner.query(`alter table ${table} alter column livemode set default false`);
    }

    // The uniqueness guarantees that were silently merging the two modes. A test-mode
    // endpoint and a live-mode endpoint may hold the same source event id.
    await queryRunner.query(`drop index if exists uq_webhook_event_source`);
    await queryRunner.query(`
      create unique index uq_webhook_event_source
        on webhook_event (endpoint_id, source_event_id, livemode)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists uq_webhook_event_source`);
    await queryRunner.query(`
      create unique index uq_webhook_event_source
        on webhook_event (endpoint_id, source_event_id)
    `);

    for (const [table] of AddLivemodeToMerchantScoped1728900000000.BACKFILLS) {
      await queryRunner.query(
        `alter table ${table} drop constraint if exists chk_${table}_livemode_present`,
      );
      await queryRunner.query(`alter table ${table} drop column if exists livemode`);
    }
  }

  /**
   * Bounded loop rather than one statement. `webhook_event` is the reason: a single update
   * over 78M rows holds row locks for the whole run and the delivery job stalls behind it.
   * `ctid`-keyed batches let each statement commit and release.
   */
  private async backfill(
    queryRunner: QueryRunner,
    table: string,
    parentExpr: string,
  ): Promise<void> {
    const batchSize = AddLivemodeToMerchantScoped1728900000000.BATCH_SIZE;

    for (;;) {
      const updated: Array<{ count: string }> = await queryRunner.query(`
        with batch as (
          select ctid from ${table} where livemode is null limit ${batchSize}
        )
        update ${table} t
           set livemode = coalesce(${parentExpr}, false)
          from batch
         where t.ctid = batch.ctid
        returning 1 as count
      `);

      if (updated.length < batchSize) {
        break;
      }
    }
  }
}
