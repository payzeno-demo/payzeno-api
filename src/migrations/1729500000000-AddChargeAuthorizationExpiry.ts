import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 32 — `charge.authorization_expires_at` + `ix_charge_authorization_expires`.
 *
 * Until now "is this authorisation still good?" was computed in application code every time
 * anyone asked, from `authorized_at` plus a window that depends on the merchant's MCC. That
 * works fine for a single charge and not at all for the hourly `ChargeExpiryJob`, which has
 * to find every expired authorisation across the table and was doing it with
 *
 *   select * from charge where status = 'authorized'
 *
 * and filtering in Node. At month 12 that is 1.4M rows an hour through the ORM.
 *
 * Materialising the expiry lets the job read a partial index instead. `ChargeExpiryPolicy`
 * stays the only place the window is *decided* — `ChargeAuthorizationService` writes the
 * column from it on authorisation — but the column is what the job scans.
 *
 * The window: 7 days standard, 30 for the deferred-settlement MCCs (travel 3000-3999,
 * lodging 7011, car rental 7512). Those are the same MCCs eligible for
 * `merchant.capture_at_settlement`, so getting this wrong voids exactly the holds that
 * feature exists to capture later.
 *
 * TODO(PAY-2231): the MCC list now lives here and in `charge-expiry.policy.ts`. If the
 * schemes move a band, one of the two will be missed. Should be a lookup table but the
 * settlement work is ahead of it in the queue.
 *
 * — ytechdebt, month 12
 */
export class AddChargeAuthorizationExpiry1729500000000 implements MigrationInterface {
  name = 'AddChargeAuthorizationExpiry1729500000000';

  /** `create index concurrently` cannot run inside a transaction block. */
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table charge add column if not exists authorization_expires_at timestamptz`,
    );

    // Backfill only the rows the job will ever look at. Captured, refunded, failed and
    // voided charges have no live authorisation, and there are ~60M of them; leaving the
    // column null there is correct and saves the rewrite.
    await queryRunner.query(`
      update charge c
         set authorization_expires_at = c.authorized_at + interval '30 days'
        from merchant m
       where m.id = c.merchant_id
         and c.status = 'authorized'
         and c.authorized_at is not null
         and (m.mcc between '3000' and '3999' or m.mcc in ('7011', '7512'))
    `);

    await queryRunner.query(`
      update charge c
         set authorization_expires_at = c.authorized_at + interval '7 days'
        from merchant m
       where m.id = c.merchant_id
         and c.status = 'authorized'
         and c.authorized_at is not null
         and c.authorization_expires_at is null
    `);

    // Partial: the job only ever asks about authorised charges, and the predicate keeps the
    // index at about 90k entries instead of 61M.
    await queryRunner.query(`
      create index concurrently if not exists ix_charge_authorization_expires
        on charge (authorization_expires_at)
        where status = 'authorized'
    `);

    // An authorised charge with no expiry is invisible to the job and would sit on the
    // cardholder's balance until the issuer drops it. NOT VALID + VALIDATE so the existing
    // rows are checked without an ACCESS EXCLUSIVE lock over the whole table.
    await queryRunner.query(`
      alter table charge
        add constraint chk_charge_authorization_expiry
        check (status <> 'authorized' or authorized_at is null or authorization_expires_at is not null)
        not valid
    `);
    await queryRunner.query(
      `alter table charge validate constraint chk_charge_authorization_expiry`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table charge drop constraint if exists chk_charge_authorization_expiry`,
    );
    await queryRunner.query(`drop index concurrently if exists ix_charge_authorization_expires`);
    await queryRunner.query(`alter table charge drop column if exists authorization_expires_at`);
  }
}
