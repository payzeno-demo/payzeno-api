import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * platform-v2 money 5 — give full-access api keys the six scopes RFC platform-v2 added
 * (`customers:*`, `prices:*`, `subscriptions:*`).
 *
 * A key minted with every scope that existed before this release was a full-access key; it
 * should stay one, or every integration that holds one starts getting 403 `permission_denied`
 * on the new resources the day they ship. Keys with a narrower grant are left exactly as their
 * owner scoped them. The test is "holds all seventeen pre-v2 scopes", listed below.
 *
 * Data-only and additive: the running image never reads a scope it does not know.
 */
const PRE_V2_SCOPES = [
  'merchants:read',
  'payment_intents:read',
  'payment_intents:write',
  'checkout_sessions:read',
  'checkout_sessions:write',
  'charges:read',
  'refunds:read',
  'refunds:write',
  'disputes:read',
  'disputes:write',
  'balance:read',
  'payouts:read',
  'payouts:write',
  'settlements:read',
  'invoices:read',
  'webhooks:read',
  'webhooks:write',
];

const V2_SCOPES = [
  'customers:read',
  'customers:write',
  'prices:read',
  'prices:write',
  'subscriptions:read',
  'subscriptions:write',
];

export class GrantPlatformV2ScopesToFullAccessKeys1731500400000 implements MigrationInterface {
  name = 'GrantPlatformV2ScopesToFullAccessKeys1731500400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      update api_key
         set scopes = array(select distinct unnest(scopes || $2::text[]) order by 1)
       where scopes @> $1::text[]
         and not scopes @> $2::text[]
      `,
      [PRE_V2_SCOPES, V2_SCOPES],
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      update api_key
         set scopes = array(select s from unnest(scopes) as s where s <> all($1::text[]) order by 1)
       where scopes @> $1::text[]
      `,
      [V2_SCOPES],
    );
  }
}
