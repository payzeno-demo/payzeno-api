/**
 * ApiKeyHasher — the two hashes of `api_key`, and why there are two.
 *
 * The token is `sk_live_<key_id_suffix>_<secret>`.
 *
 *   lookup_hash = HMAC-SHA256(secret, API_KEY_PEPPER)  deterministic, uniquely indexed,
 *                 gives ApiKeyResolver an O(1) lookup.
 *   secret_hash = argon2id(secret)                     salted, for the constant-time verify.
 *
 * A unique index on a salted argon2id hash is meaningless, and the only alternative —
 * argon2-verifying every row in the table until one matches — is not an authentication
 * design. data-model.md §1.3.
 *
 * API_KEY_PEPPER is a pepper, not a salt: it lives in SSM, never in the database, and
 * rotating it invalidates every live key in the environment. docs/runbooks/payzeno-api.md
 * has the rotation procedure and it is not a fast one.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';

/** OWASP's 2024 argon2id baseline. Raising these is a migration, not a config change. */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
};

const SECRET_BYTES = 24;

export interface MintedApiKeySecret {
  /** The random half of the token. Returned to the merchant exactly once. */
  secret: string;
  lookupHash: string;
  secretHash: string;
  lastFour: string;
}

@Injectable()
export class ApiKeyHasher {
  private readonly pepper: string;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.pepper = config.auth.apiKeyPepper;
  }

  /** Deterministic. The uniquely-indexed column. */
  lookupHash(secret: string): string {
    return createHmac('sha256', this.pepper).update(secret).digest('hex');
  }

  hashSecret(secret: string): Promise<string> {
    return argon2.hash(secret, ARGON2_OPTIONS);
  }

  /**
   * Constant-time by construction — argon2's own verify is. The try/catch swallows a malformed
   * stored hash into `false` rather than a 500: a corrupt row must fail authentication, not
   * take the endpoint down.
   */
  async verifySecret(storedHash: string, presentedSecret: string): Promise<boolean> {
    try {
      return await argon2.verify(storedHash, presentedSecret, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /** Generates a new secret and both of its hashes. Called once per `POST /v1/api-keys`. */
  async mint(): Promise<MintedApiKeySecret> {
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    return {
      secret,
      lookupHash: this.lookupHash(secret),
      secretHash: await this.hashSecret(secret),
      lastFour: secret.slice(-4),
    };
  }

  /**
   * `sk_live_<key_id_suffix>_<secret>`. The id suffix is decoration for humans reading logs —
   * the lookup keys on the secret's HMAC, never on the suffix, so a merchant who mangles the
   * middle segment still authenticates and a merchant who mangles the secret does not.
   */
  formatToken(mode: 'live' | 'test', apiKeyId: string, secret: string): string {
    return `sk_${mode}_${apiKeyId.slice(-8)}_${secret}`;
  }

  /** Same-length comparison for the non-argon2 comparisons (CSRF, internal shared secret). */
  static constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
