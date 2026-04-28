import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 16 — PAY-2051. Committed at 03:10 during the PAY-2041 incident.
 *
 * `uq_charge_processor_reference (acquirer, processor_reference)`.
 *
 * Be precise about what this does and does not do, because the postmortem had to be:
 *
 *   It DOES stop payzeno-api double-AUTHORISING. A retried authorise that comes back with a
 *   processor reference we already hold now fails on insert instead of creating a second
 *   charge row.
 *
 *   It does NOT defend against the incident. The duplicate capture was issued by
 *   payzeno-ledger's SettlementPoster against a completely separate database that holds only
 *   a `settlement_charge` projection. The ledger never writes `charge`, so this index is
 *   never consulted on the path that double-charged. The control that sits on that path is
 *   `capture_attempt` in `payzeno_ledger` (data-model.md §3.12), inserted BEFORE the acquirer
 *   call under its own unique key.
 *
 * It went in anyway, at 03:10, because it was cheap and correct and nobody wanted to argue at
 * 03:10. Built with a duplicate check first: any rows that already collide are a real second
 * charge and needed a human before the index could exist at all.
 *
 * — dhotfix, month 9, during the incident
 */
export class AddUniqueProcessorReference1725000000000 implements MigrationInterface {
  name = 'AddUniqueProcessorReference1725000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const collisions: Array<{ acquirer: string; processor_reference: string; n: string }> =
      await queryRunner.query(`
        select acquirer, processor_reference, count(*) as n
          from charge
         where processor_reference is not null
         group by acquirer, processor_reference
        having count(*) > 1
      `);

    if (collisions.length > 0) {
      throw new Error(
        `refusing to create uq_charge_processor_reference: ${collisions.length} duplicate ` +
          `(acquirer, processor_reference) pairs exist and each one is a charge somebody has ` +
          `to look at. First: ${collisions[0].acquirer}/${collisions[0].processor_reference}`,
      );
    }

    await queryRunner.query(`
      create unique index uq_charge_processor_reference
        on charge (acquirer, processor_reference)
        where processor_reference is not null
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop index if exists uq_charge_processor_reference`);
  }
}
