import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 28 — 3-D Secure. `charge.three_d_secure`, `charge.sca_exemption`,
 * `payment_intent.next_action`, and the `requires_action` status value.
 *
 * Not optional. EUR and GBP are supported currencies and under PSD2 an e-commerce
 * authorisation without SCA or a documented exemption is declined by the issuer, so without
 * these columns the European book simply does not work. `liability_shifted` inside
 * `three_d_secure` also decides whether a `fraudulent` dispute is the merchant's loss or the
 * issuer's, which is the difference between a chargeback and a note in a report.
 *
 * `three_d_secure` is jsonb rather than five columns because the shape is the network's, not
 * ours: version, authentication_flow, result, eci, liability_shifted, and whatever the
 * schemes add next.
 *
 * Adding an enum value is a migration and removing one is not allowed — `requires_action`
 * goes in after `processing` so the ordinal order still reads like the lifecycle.
 *
 * — osquash, month 11
 */
export class AddCardScaFields1727100000000 implements MigrationInterface {
  name = 'AddCardScaFields1727100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter type payment_intent_status add value if not exists 'requires_action' after 'processing'
    `);

    await queryRunner.query(`create type sca_exemption as enum ('low_value', 'tra', 'moto', 'recurring')`);

    await queryRunner.query(`alter table charge add column three_d_secure jsonb`);
    await queryRunner.query(`alter table charge add column sca_exemption sca_exemption`);
    await queryRunner.query(`alter table payment_intent add column next_action jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The enum value stays. Postgres cannot drop one, and the rule in data-model.md says so
    // out loud: adding a value is a migration, removing one is not allowed.
    await queryRunner.query(`alter table payment_intent drop column if exists next_action`);
    await queryRunner.query(`alter table charge drop column if exists sca_exemption`);
    await queryRunner.query(`alter table charge drop column if exists three_d_secure`);
    await queryRunner.query(`drop type if exists sca_exemption`);
  }
}
