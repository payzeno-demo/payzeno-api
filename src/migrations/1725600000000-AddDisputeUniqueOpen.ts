import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 17 — `uq_dispute_charge_open`.
 *
 * A charge may be disputed more than once over its life (a chargeback, then a
 * pre-arbitration), but it may have only ONE open dispute at a time. Both acquirers retry
 * their webhooks, and without this index the same chargeback notification arriving twice
 * opened two disputes, held the amount twice, and charged the merchant two dispute fees.
 *
 * Partial and unique on `charge_id where status in ('needs_response','under_review')`. It is
 * also the constraint `DisputesService.openFromWebhook` catches 23505 on and turns into
 * `DuplicateDisputeException` — the check-then-insert version of this lost the race about
 * once a fortnight.
 *
 * — ytechdebt, month 10
 */
export class AddDisputeUniqueOpen1725600000000 implements MigrationInterface {
  name = 'AddDisputeUniqueOpen1725600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Resolve any existing overlap before the index refuses to build. The older row is the
    // real dispute; the newer one is the duplicate webhook, and marking it warning_closed
    // keeps it visible in the timeline rather than deleting evidence.
    await queryRunner.query(`
      update dispute d
         set status = 'warning_closed', resolved_at = now()
       where d.status in ('needs_response', 'under_review')
         and exists (
           select 1 from dispute earlier
            where earlier.charge_id = d.charge_id
              and earlier.status in ('needs_response', 'under_review')
              and earlier.created_at < d.created_at
         )
    `);

    await queryRunner.query(`
      create unique index uq_dispute_charge_open on dispute (charge_id)
        where status in ('needs_response', 'under_review')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists uq_dispute_charge_open`);
  }
}
