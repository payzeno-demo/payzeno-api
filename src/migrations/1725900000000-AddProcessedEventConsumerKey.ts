import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 26 — INC hardening. `processed_event` primary key becomes `(event_id, consumer)`.
 *
 * The dedupe claim is per consumer, not per event, and the key has to say so. payzeno-api has
 * two consumers whose handled sets overlap — `LedgerEventsConsumer` and `DeadLetterConsumer`,
 * whose handled set is "everything, for redrive" — so with `event_id` alone any redriven
 * event already processed by the first collides on insert. `claimEvent` returns false, the
 * DLQ consumer concludes it is a duplicate, and the redrive silently does nothing.
 *
 * That is exactly what happened at 04:20 on the night of PAY-2041 while somebody was trying
 * to redrive the queue by hand.
 *
 * Safe to widen a primary key here because the existing rows already carry `consumer` — it
 * has been NOT NULL since migration 07, it simply was not part of the key.
 *
 * — osquash, month 9
 */
export class AddProcessedEventConsumerKey1725900000000 implements MigrationInterface {
  name = 'AddProcessedEventConsumerKey1725900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table processed_event drop constraint processed_event_pkey`);
    await queryRunner.query(`
      alter table processed_event
        add constraint processed_event_pkey primary key (event_id, consumer)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Narrowing the key can genuinely fail: once two consumers have claimed the same event
    // there are duplicate event_ids. Drop those rows to the consumer that claimed first,
    // which is the state the old key could represent.
    await queryRunner.query(`
      delete from processed_event p
       where exists (
         select 1 from processed_event other
          where other.event_id = p.event_id
            and other.processed_at < p.processed_at
       )
    `);
    await queryRunner.query(`alter table processed_event drop constraint processed_event_pkey`);
    await queryRunner.query(`
      alter table processed_event add constraint processed_event_pkey primary key (event_id)
    `);
  }
}
