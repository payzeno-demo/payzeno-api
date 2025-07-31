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
    const now = this.clock.now();
  }
}
