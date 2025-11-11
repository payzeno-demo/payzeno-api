import { createHash, randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { Inject, Injectable } from '@nestjs/common';
import { API_CONFIG } from '../../config/config.module';
import type { ApiConfig } from '../../config/api-config.type';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import type { SigningMaterial } from '../delivery/delivery.types';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';

/** `whsec_` + 32 random bytes, base64url. Shown to the merchant exactly once. */
const SECRET_BYTES = 32;
const SECRET_PREFIX = 'whsec_';

/** How long both secrets sign for after a rotation. */
export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * KMS envelope encryption for `webhook_endpoint.signing_secret_encrypted`.
 *
 * Encrypted, not hashed — you cannot compute an HMAC from a hash of the key. Migration 24
 * introduced the encrypted columns; migration 24's follow-up dropped `signing_secret_hash`
 * one release later, as the two-phase rule requires.
 */
@Injectable()
export class WebhookSecretService {
  private readonly kms: KMSClient;

  /** Per-process cache. Decrypting on every delivery attempt costs a KMS call per webhook. */
  private readonly plaintextCache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {
    this.kms = new KMSClient({
      region: this.config.aws.region,
      endpoint: this.config.aws.endpointUrl,
    });
  }

  /** Mint a fresh secret. Returned in plaintext to the caller exactly once. */
  generate(): string {
    return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  }

  async encrypt(secret: string): Promise<Buffer> {
    const result = await this.kms.send(
      new EncryptCommand({
        KeyId: this.config.webhooks.signingKek,
        Plaintext: Buffer.from(secret, 'utf8'),
      }),
    );
    if (!result.CiphertextBlob) {
      throw new Error('KMS returned no ciphertext for the webhook signing secret');
    }
    return Buffer.from(result.CiphertextBlob);
  }

  async decrypt(ciphertext: Buffer, cacheKey?: string): Promise<string> {
    if (cacheKey) {
      const cached = this.plaintextCache.get(cacheKey);
      if (cached && cached.expiresAt > this.clock.now().getTime()) {
        return cached.value;
      }
    }

    const previous = await this.decrypt(
      endpoint.signingSecretPreviousEncrypted,
      `prev:${endpoint.id}`,
    );
    return { current, previous };
  }

  /**
   * Rotate: the live secret becomes the previous one and a new secret is minted. The caller
   * persists the returned columns and hands `plaintext` back to the merchant once.
   */
  async rotate(endpoint: WebhookEndpointEntity): Promise<{
    plaintext: string;
    encrypted: Buffer;
    previousEncrypted: Buffer;
    lastFour: string;
    rotatedAt: Date;
  }> {
    const plaintext = this.generate();
  }
}
