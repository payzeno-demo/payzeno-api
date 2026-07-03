import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 19 — `api_key.scopes`.
 *
 * `@RequiredScopes(...)` had a vocabulary (`API_KEY_SCOPES` in @payzeno/contracts) and no
 * column to check it against, so every live key was effectively full-access. This adds the
 * column and backfills every existing key with the read scopes plus the write scopes it has
 * demonstrably been using — which is not something a migration can know, so the backfill is
 * conservative: read everything, write nothing.
 *
 * osquash asked for the conservative direction and he was right. The alternative — grant
 * everything so nothing breaks — makes the column decorative on day one and nobody ever
 * narrows it afterwards. Merchants whose keys needed write scopes were mailed and the console
 * has a one-click "grant" on the key page.
 *
 * Three review rounds. The one I got wrong was defaulting the column to '{}' and backfilling
 * in the same statement, which would have left keys created DURING the deploy with no scopes
 * at all.
 *
 * — ystackoverflow, month 11
 */
export class AddApiKeyScopes1726800000000 implements MigrationInterface {
  name = 'AddApiKeyScopes1726800000000';

  private readonly readScopes = [
    'merchants:read',
    'payment_intents:read',
    'charges:read',
    'refunds:read',
    'disputes:read',
    'balance:read',
    'payouts:read',
    'settlements:read',
    'invoices:read',
    'webhooks:read',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const literal = `{${this.readScopes.join(',')}}`;

    // Default first, so a key created while the deploy is in flight is never scope-less.
    await queryRunner.query(
      `alter table api_key add column scopes text[] not null default '${literal}'::text[]`,
    );

    await queryRunner.query(
      `update api_key set scopes = '${literal}'::text[] where scopes = '{}'::text[]`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`alter table api_key drop column if exists scopes`);
  }
}
