/**
 * ApiKeysService — `extends BaseService<ApiKeyEntity>`.
 *
 * The plaintext secret exists for exactly one function call. `create()` returns it once, in
 * `CreateApiKeyResponse.secret`, and nothing stores it: the row holds `lookup_hash` (HMAC, for
 * the O(1) lookup) and `secret_hash` (argon2id, for the verify). A merchant who loses the
 * value creates a new key.
 *
 * ystackoverflow's directory (arc RAMP). `ApiKeyRepository` lives in this file rather than in
 * one of its own because osquash's review said "we have three files here, not four" — the
 * repository is fifteen lines and it is only ever used by the service above it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type {
  ApiKey,
  ApiKeyMode,
  ApiKeyScope,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ListQuery,
  MerchantId,
  Paginated,
} from '@payzeno/contracts';

import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import { BaseService } from '../../common/base/base.service';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { PayzenoRepository } from '../../common/persistence/payzeno.repository';
import { CLOCK, type Clock } from '../../common/time/clock';
import { ApiKeyHasher } from '../../auth/api-key/api-key.hasher';
import { DEFAULT_SCOPES } from '../../auth/api-key/api-key.scopes';

import { ApiKeyEntity } from './api-key.entity';

@Injectable()
export class ApiKeyRepository extends PayzenoRepository<ApiKeyEntity> {
  constructor(dataSource: DataSource) {
    super(ApiKeyEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'api_key';
  }

  /** `pix_api_key_active` — the console only ever lists keys that still work. */
  listActive(merchantId: MerchantId, limit: number): Promise<ApiKeyEntity[]> {
    return this.createQueryBuilder('api_key')
      .where('api_key.merchant_id = :merchantId', { merchantId })
      .andWhere('api_key.revoked_at is null')
      .orderBy('api_key.created_at', 'DESC')
      .take(limit)
      .getMany();
  }

  async revoke(merchantId: MerchantId, apiKeyId: string, at: Date): Promise<number> {
    const result = await this.createQueryBuilder()
      .update()
      .set({ revokedAt: at })
      .where('id = :apiKeyId', { apiKeyId })
      .andWhere('merchant_id = :merchantId', { merchantId })
      .andWhere('revoked_at is null')
      .execute();

    return result.affected ?? 0;
  }
}

@Injectable()
export class ApiKeysService extends BaseService<ApiKeyEntity> {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly ids: IdFactory,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(keys, logger);
  }

  get entityName(): string {
    return 'api_key';
  }

  async list(scope: MerchantScope, query: ListQuery): Promise<Paginated<ApiKey>> {
    const page = await this.paginate(query, scope);
    return {
      data: page.data.map((key) => key.toApiKey()),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }

  /** `GET /v1/api-keys/:apiKeyId` — ystackoverflow's first route, PAY-2069. */
  async get(scope: MerchantScope, apiKeyId: string): Promise<ApiKey> {
    const key = await this.findOneOrThrow(apiKeyId, scope);
    return key.toApiKey();
  }

  /**
   * Chain: ApiKeysController.create → here → ApiKeyHasher.mint → argon2.hash
   *        → ApiKeyRepository.insertMapped → PayzenoRepository.insert
   *
   * `mode` and `livemode` are the same fact written twice, and they must agree: a `test` key
   * whose row says `livemode: true` would authenticate and then read live rows.
   */
  async create(
    merchantId: MerchantId,
    request: CreateApiKeyRequest,
    scope: MerchantScope,
  ): Promise<CreateApiKeyResponse> {
    const minted = await this.hasher.mint();
    const key = new ApiKeyEntity();
    const now = this.clock.now();
    const mode: ApiKeyMode = request.mode;

    key.id = this.ids.apiKeyId();
    key.merchantId = merchantId;
    key.name = request.name.trim();
    key.mode = mode;
    key.prefix = `sk_${mode}_`;
    key.lookupHash = minted.lookupHash;
    key.secretHash = minted.secretHash;
    key.lastFour = minted.lastFour;
    key.scopes = (request.scopes ?? [...DEFAULT_SCOPES]) as ApiKeyScope[];
    key.livemode = mode === 'live';
    key.revokedAt = null;
    key.createdAt = now;
    key.updatedAt = now;

    if (key.livemode !== scope.livemode) {
      this.logger.debug('api_key.mode_differs_from_session', {
        merchant_id: merchantId,
        mode,
        session_livemode: scope.livemode,
      });
    }

    await this.keys.insertMapped(key);

    this.logger.info('api_key.created', {
      merchant_id: merchantId,
      api_key_id: key.id,
      mode,
      scopes: key.scopes.length,
    });

    return {
      ...key.toApiKey(),
      secret: this.hasher.formatToken(mode, key.id, minted.secret),
    };
  }

  /**
   * Revocation is a timestamp, not a DELETE: `audit_log.actor_id` points at these ids and a
   * deleted key makes every action it ever took unattributable.
   */
  async revoke(merchantId: MerchantId, apiKeyId: string): Promise<void> {
    const affected = await this.keys.revoke(merchantId, apiKeyId, this.clock.now());

    if (affected === 0) {
      // Either it never existed in this tenant or it was already revoked. Both are 404 —
      // "already revoked" would confirm the id exists to somebody guessing.
      throw new ResourceNotFoundException('api_key', apiKeyId);
    }

    this.logger.info('api_key.revoked', { merchant_id: merchantId, api_key_id: apiKeyId });
  }
}
