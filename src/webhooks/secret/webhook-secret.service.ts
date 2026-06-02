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

    const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    if (!result.Plaintext) {
      throw new Error('KMS returned no plaintext for the webhook signing secret');
    }
    const value = Buffer.from(result.Plaintext).toString('utf8');

    if (cacheKey) {
      this.plaintextCache.set(cacheKey, {
        value,
        expiresAt: this.clock.now().getTime() + 5 * 60 * 1000,
      });
    }
    return value;
  }

  /**
   * What the delivery strategies sign with. During the 24h overlap after a rotation both
   * secrets are returned and both signatures go out, so a merchant can cut over without
   * dropping deliveries.
   */
  async signingMaterial(endpoint: WebhookEndpointEntity, now: Date): Promise<SigningMaterial> {
    const current = await this.decrypt(endpoint.signingSecretEncrypted, `cur:${endpoint.id}`);

    if (!endpoint.signingSecretPreviousEncrypted || !endpoint.rotatedAt) {
      return { current, previous: null };
    }
    if (now.getTime() - endpoint.rotatedAt.getTime() >= ROTATION_OVERLAP_MS) {
      return { current, previous: null };
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
    const encrypted = await this.encrypt(plaintext);

    this.plaintextCache.delete(`cur:${endpoint.id}`);
    this.plaintextCache.delete(`prev:${endpoint.id}`);

    this.logger.info('webhook.secret_rotated', {
      endpoint_id: endpoint.id,
      merchant_id: endpoint.merchantId,
    });

    return {
      plaintext,
      encrypted,
      previousEncrypted: endpoint.signingSecretEncrypted,
      lastFour: this.lastFour(plaintext),
      rotatedAt: this.clock.now(),
    };
  }

  lastFour(secret: string): string {
    return secret.slice(-4);
  }

  /**
   * LEGACY. Before migration 24 the secret was stored as `sha256(secret)` in
   * `signing_secret_hash`, which made signing impossible and was the bug that started the
   * whole rewrite. The column is gone; this survives so the one endpoint that was created
   * during the migration window and never re-rotated can still be identified in support.
   *
   * TODO(PAY-1902): delete after the last pre-migration-24 endpoint has rotated.
   * Kept "one release" after migration 24. It is month 12.
   */
  readLegacySigningSecretHash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}
