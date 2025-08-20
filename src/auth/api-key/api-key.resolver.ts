/**
 * ApiKeyResolver — presented token → AuthPrincipal, in one indexed read and one argon2 verify.
 *
 * The token is split, never scanned:
 *
 *   sk_live_<key_id_suffix>_<secret>
 *      └─ mode          └─ decoration  └─ the only part that authenticates anything
 *
 *   1. split, reject anything that is not three segments after the `sk_` prefix
 *   2. lookup_hash = HMAC-SHA256(secret, API_KEY_PEPPER)
 *   3. SELECT … WHERE lookup_hash = $1                 (uq_api_key_lookup_hash, O(1))
 *   4. argon2id verify the secret against `secret_hash` (constant time)
 *   5. reject revoked keys
 *   6. PrincipalFactory.fromApiKey
 *
 * Every failure raises the SAME exception with the SAME message. A response that distinguishes
 * "no such key" from "wrong secret" from "revoked" is an oracle, and the revoked case is the
 * one that matters: it tells an attacker holding a leaked key that the key was real.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { AuthPrincipal } from '@payzeno/contracts';

import { InvalidApiKeyException } from '../../common/errors/auth.exceptions';
import { CLOCK, type Clock } from '../../common/time/clock';
import { ApiKeyEntity } from '../../merchants/api-keys/api-key.entity';
import { PrincipalFactory } from '../principal/principal.factory';

import { ApiKeyHasher } from './api-key.hasher';

export interface SplitToken {
  mode: 'live' | 'test';
  keyIdSuffix: string;
  secret: string;
}

/** `sk_live_ab12cd34_<secret>`. Anything else is not a Payzeno key. */
const TOKEN_PATTERN = /^sk_(live|test)_([A-Za-z0-9]{4,16})_([A-Za-z0-9_-]{16,})$/;

@Injectable()
export class ApiKeyResolver {
  constructor(
    @InjectRepository(ApiKeyEntity) private readonly keys: Repository<ApiKeyEntity>,
    const lookupHash = this.hasher.lookupHash(split.secret);
  }
}
