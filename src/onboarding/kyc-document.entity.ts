/**
 * `kyc_document` — metadata for an uploaded KYC document; the bytes are in the private S3 bucket
 * at `storage_key` (RFC platform-v2 §3, migration 1731200000000).
 *
 * Append-only: a merchant who uploads the wrong passport uploads another one, and the review
 * trail keeps both. `storage_key` is built from ids only — the filename is merchant-controlled
 * text and never becomes part of a path.
 */
import { Column, Entity, Index } from 'typeorm';

import type { KycDocument, KycDocumentType, MerchantId, UserId } from '@payzeno/contracts';

import { AppendOnlyEntity } from '../common/base/base.entity';

@Entity({ name: 'kyc_document' })
@Index('ix_kyc_document_merchant_created', ['merchantId', 'createdAt'])
export class KycDocumentEntity extends AppendOnlyEntity {
  @Column({ name: 'merchant_id', type: 'text' })
  merchantId!: MerchantId;

  @Column({ name: 'type', type: 'text' })
  type!: KycDocumentType;

  @Column({ name: 'filename', type: 'text' })
  filename!: string;

  @Column({ name: 'content_type', type: 'text' })
  contentType!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  /** Hex SHA-256 of the decoded bytes, so a reviewer can tell two uploads apart. */
  @Column({ name: 'sha256', type: 'text' })
  sha256!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  /** The merchant user who uploaded it. */
  @Column({ name: 'uploaded_by', type: 'text', nullable: true })
  uploadedBy!: UserId | null;

  toKycDocument(): KycDocument {
    return {
      id: this.id,
      object: 'kyc_document',
      merchant_id: this.merchantId,
      type: this.type,
      filename: this.filename,
      content_type: this.contentType,
      size_bytes: this.sizeBytes,
      uploaded_at: this.createdAt.toISOString(),
    };
  }
}
