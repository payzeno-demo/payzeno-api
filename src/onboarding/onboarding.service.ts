/**
 * OnboardingService — KYC onboarding, RFC platform-v2 §3. Merchant side and staff side.
 *
 *   merchant  GET/PATCH /v1/onboarding, POST /v1/onboarding/documents, POST /v1/onboarding/submit
 *   staff     POST /v1/admin/merchants/:id/onboarding/{approve|reject|request-info}
 *
 * `merchant.status` is the outward truth and this keeps it truthful: `pending_review` until a
 * reviewer approves (→ `active`) or rejects (→ `rejected`), always through
 * `MerchantsService.changeStatus` so `merchant.status_changed` reaches the ledger and the legacy
 * biller. A decision — onboarding state, merchant status, staff audit row, the email to the
 * merchant — is one transaction under a row lock on `merchant_onboarding`.
 *
 * Every merchant has a row. Signup creates it; a merchant made before this existed (or by
 * `POST /v1/merchants`) gets a `collecting` one the first time anybody looks.
 *
 * Document bytes go to S3 before the metadata row is written. A failed insert after a successful
 * put leaves an unreferenced object, which is the cheap failure; the other order leaves a row
 * pointing at nothing, which a reviewer clicks on.
 */
import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type {
  BankAccount,
  BusinessProfile,
  EmailTemplate,
  KycDocument,
  MerchantId,
  Onboarding,
  Representative,
  UpdateOnboardingRequest,
  UploadKycDocumentRequest,
  UserId,
} from '@payzeno/contracts';

import { ValidationException } from '../common/errors/api.exception';
import { OnboardingIncompleteException } from '../common/errors/identity.exceptions';
import { MerchantNotFoundException, ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { getRequestContext } from '../common/logging/request-context';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { BankAccountRepository } from '../merchants/bank-accounts/bank-accounts.service';
import { MerchantMailerService } from '../merchants/merchant-mailer.service';
import { MerchantRepository } from '../merchants/merchant.repository';
import { MerchantsService } from '../merchants/merchants.service';
import { StaffAuditService } from '../staff/staff-audit.service';

import { KYC_DOCUMENT_MAX_BYTES } from './dto/onboarding.dto';
import { KycDocumentEntity } from './kyc-document.entity';
import { KycStorageClient, type StoredObject } from './kyc-storage-http.client';
import { requirementsDue } from './onboarding-requirements.policy';
import { OnboardingEntity } from './onboarding.entity';
import { OnboardingRepository } from './onboarding.repository';
import { DECISION_EVENTS, OnboardingStateMachine, type OnboardingDecision } from './state/onboarding.state-machine';

/** The operator behind a staff decision, for `staff_audit_log`. */
export interface StaffActor {
  staffId: string;
  ip: string | null;
}

const DECISION_EMAILS: Readonly<Record<OnboardingDecision, EmailTemplate>> = {
  approve: 'onboarding_approved',
  reject: 'onboarding_rejected',
  'request-info': 'onboarding_info_requested',
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly onboarding: OnboardingRepository,
    private readonly states: OnboardingStateMachine,
    private readonly storage: KycStorageClient,
    private readonly bankAccounts: BankAccountRepository,
    private readonly merchants: MerchantRepository,
    private readonly merchantsService: MerchantsService,
    private readonly mailer: MerchantMailerService,
    private readonly staffAudit: StaffAuditService,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  // -- merchant side -----------------------------------------------------------------------------

  /** `GET /v1/onboarding`. */
  async get(merchantId: MerchantId): Promise<Onboarding> {
    return this.describe(await this.getOrCreate(merchantId));
  }

  /** Signup's row, in signup's transaction. */
  async createFor(merchantId: MerchantId, manager: EntityManager): Promise<void> {
    await this.onboarding.insertIfMissing(this.newRow(merchantId), manager);
  }

  /** `PATCH /v1/onboarding`. Only in `collecting` / `needs_info`; 409 `invalid_state` otherwise. */
  async update(merchantId: MerchantId, request: UpdateOnboardingRequest): Promise<Onboarding> {
    const row = await this.transactions.runInTransaction(async (manager) => {
      const locked = await this.lockOrCreate(merchantId, manager);
      this.states.assertEditable(locked.state);

      if (request.business_profile) {
        locked.businessProfile = { ...locked.businessProfile, ...cleanPatch(request.business_profile) };
      }
      if (request.representative) {
        locked.representative = { ...locked.representative, ...cleanPatch(request.representative) };
      }

      await this.onboarding.saveLocked(locked, manager);
      return locked;
    });

    return this.describe(row);
  }

  /** `POST /v1/onboarding/documents`. Base64 in, metadata out; the bytes never come back. */
  async uploadDocument(
    merchantId: MerchantId,
    request: UploadKycDocumentRequest,
    uploadedBy: UserId | null,
  ): Promise<KycDocument> {
    const row = await this.getOrCreate(merchantId);
    this.states.assertEditable(row.state);

    const bytes = decodeDocument(request.content_base64);
    const document = new KycDocumentEntity();
    document.id = this.ids.opaque('kyc_');
    document.merchantId = merchantId;
    document.type = request.type;
    document.filename = safeFilename(request.filename);
    document.contentType = request.content_type;
    document.sizeBytes = bytes.length;
    document.sha256 = createHash('sha256').update(bytes).digest('hex');
    document.storageKey = `merchants/${merchantId}/kyc/${document.id}`;
    document.uploadedBy = uploadedBy;
    document.createdAt = this.clock.now();

    await this.storage.put(document.storageKey, bytes, document.contentType);
    await this.onboarding.appendDocument(document);

    this.logger.info('onboarding.document_uploaded', {
      merchant_id: merchantId,
      kyc_document_id: document.id,
      type: document.type,
      size_bytes: document.sizeBytes,
    });
    return document.toKycDocument();
  }

  /** `POST /v1/onboarding/submit`. 409 `invalid_state` while anything is still due. */
  async submit(merchantId: MerchantId): Promise<Onboarding> {
    const row = await this.transactions.runInTransaction(async (manager) => {
      const locked = await this.lockOrCreate(merchantId, manager);
      const next = this.states.apply(locked.state, 'submit');

      const due = requirementsDue(await this.factsFor(locked, manager));
      if (due.length > 0) throw new OnboardingIncompleteException(due);

      locked.state = next;
      locked.submittedAt = this.clock.now();
      // The reviewer's last request has been answered; the console should stop showing it.
      locked.staffMessage = null;
      await this.onboarding.saveLocked(locked, manager);
      return locked;
    });

    this.logger.info('onboarding.submitted', { merchant_id: merchantId });
    return this.describe(row);
  }

  // -- staff side --------------------------------------------------------------------------------

  /**
   * Approve, reject or ask for more. `message` is required for the latter two and reaches the
   * merchant verbatim, in the console and in the email.
   */
  async decide(
    merchantId: MerchantId,
    decision: OnboardingDecision,
    message: string | null,
    staff: StaffActor,
  ): Promise<void> {
    const note = message?.trim() || null;
    if (decision !== 'approve' && !note) {
      throw new ValidationException(`A message is required to ${decision} — it is shown to the merchant`, [
        { path: 'message', code: 'required', message: 'tell the merchant why' },
      ]);
    }

    await this.transactions.runInTransaction(async (manager) => {
      const row = await this.lockOrCreate(merchantId, manager);
      const before = { state: row.state, staff_message: row.staffMessage };

      row.state = this.states.apply(row.state, DECISION_EVENTS[decision]);
      row.staffMessage = note;
      row.decidedAt = this.clock.now();
      row.decidedBy = staff.staffId;
      await this.onboarding.saveLocked(row, manager);

      const merchantStatus = await this.applyToMerchant(merchantId, decision, note, staff, manager);

      await this.staffAudit.record(
        {
          staffId: staff.staffId,
          actingMerchantId: merchantId,
          action: `onboarding.${decision}`,
          resourceType: 'onboarding',
          resourceId: row.id,
          before,
          after: { state: row.state, staff_message: note, merchant_status: merchantStatus },
          reason: note,
          requestId: getRequestContext()?.requestId ?? 'unknown',
          ip: staff.ip,
        },
        manager,
      );

      await this.mailer.queueToAdmins(
        merchantId,
        DECISION_EMAILS[decision],
        {
          message: note,
          console_url: this.mailer.consoleLink(decision === 'request-info' ? '/onboarding' : '/'),
        },
        { manager },
      );
    });

    this.logger.info('onboarding.decided', { merchant_id: merchantId, decision, staff_id: staff.staffId });
  }

  /** Several merchants' rows at once, for the admin list. Missing means `collecting`. */
  async rowsFor(merchantIds: readonly MerchantId[]): Promise<Map<MerchantId, OnboardingEntity>> {
    const rows = await this.onboarding.findManyByMerchants(merchantIds);
    return new Map(rows.map((row) => [row.merchantId, row]));
  }

  /** The document's bytes, for the audited admin content route. */
  async readDocument(
    merchantId: MerchantId,
    documentId: string,
  ): Promise<{ document: KycDocumentEntity; object: StoredObject }> {
    const document = await this.onboarding.findDocument(merchantId, documentId);
    if (!document) throw new ResourceNotFoundException('kyc_document', documentId);
    return { document, object: await this.storage.get(document.storageKey) };
  }

  /**
   * The demo seed: a merchant that was onboarded by hand gets the profile it would have
   * submitted and an `approved` row, without a reviewer, an email or a status change.
   */
  async markApprovedForSeed(
    merchantId: MerchantId,
    profile: BusinessProfile,
    representative: Representative,
  ): Promise<void> {
    await this.transactions.runInTransaction(async (manager) => {
      const row = await this.lockOrCreate(merchantId, manager);
      row.businessProfile = { ...profile };
      row.representative = { ...representative };
      row.state = 'approved';
      row.submittedAt = row.submittedAt ?? this.clock.now();
      row.decidedAt = row.decidedAt ?? this.clock.now();
      row.decidedBy = row.decidedBy ?? 'seed-demo';
      row.staffMessage = null;
      await this.onboarding.saveLocked(row, manager);
    });
  }

  /** Live bank accounts, for the admin detail. */
  async bankAccountsFor(merchantId: MerchantId): Promise<BankAccount[]> {
    const rows = await this.bankAccounts.scopedQuery({ merchantId, livemode: true }).getMany();
    return rows.map((row) => row.toBankAccount());
  }

  // -- internals ---------------------------------------------------------------------------------

  private async applyToMerchant(
    merchantId: MerchantId,
    decision: OnboardingDecision,
    note: string | null,
    staff: StaffActor,
    manager: EntityManager,
  ): Promise<string> {
    const merchant = await this.merchants.findById(merchantId, manager);
    if (!merchant) throw new MerchantNotFoundException(merchantId);

    // Only a merchant still waiting on review changes status. Approving the onboarding of a
    // merchant risk has since restricted must not quietly reinstate it.
    if (merchant.status !== 'pending_review' || decision === 'request-info') return merchant.status;

    const to = decision === 'approve' ? 'active' : 'rejected';
    const updated = await this.merchantsService.changeStatus(
      merchantId,
      to,
      note ?? `onboarding ${decision}d`,
      `staff:${staff.staffId}`,
      manager,
    );
    return updated.status;
  }

  private async getOrCreate(merchantId: MerchantId): Promise<OnboardingEntity> {
    const existing = await this.onboarding.findByMerchant(merchantId);
    if (existing) return existing;

    if (!(await this.merchants.findById(merchantId))) throw new MerchantNotFoundException(merchantId);
    await this.onboarding.insertIfMissing(this.newRow(merchantId));
    const created = await this.onboarding.findByMerchant(merchantId);
    if (!created) throw new MerchantNotFoundException(merchantId);
    return created;
  }

  private async lockOrCreate(merchantId: MerchantId, manager: EntityManager): Promise<OnboardingEntity> {
    let row = await this.onboarding.lockForMerchant(merchantId, manager);
    if (!row) {
      if (!(await this.merchants.findById(merchantId, manager))) throw new MerchantNotFoundException(merchantId);
      await this.onboarding.insertIfMissing(this.newRow(merchantId), manager);
      row = await this.onboarding.lockForMerchant(merchantId, manager);
    }
    if (!row) throw new MerchantNotFoundException(merchantId);
    return row;
  }

  private newRow(merchantId: MerchantId): OnboardingEntity {
    const now = this.clock.now();
    const row = new OnboardingEntity();
    // Same id body as the backfill: one onboarding per merchant, so its ULID is the merchant's.
    row.id = `onb_${merchantId.slice(merchantId.indexOf('_') + 1)}`;
    row.merchantId = merchantId;
    row.state = 'collecting';
    row.businessProfile = {};
    row.representative = {};
    row.staffMessage = null;
    row.submittedAt = null;
    row.decidedAt = null;
    row.decidedBy = null;
    row.createdAt = now;
    row.updatedAt = now;
    return row;
  }

  private async factsFor(row: OnboardingEntity, manager?: EntityManager) {
    const accounts = await this.bankAccounts.scopedQuery({ merchantId: row.merchantId, livemode: true }, manager).getMany();
    return {
      profile: row.profile(),
      representative: row.rep(),
      bankAccountStatuses: accounts.map((account) => account.status),
      documentTypes: await this.onboarding.documentTypes(row.merchantId, manager),
    };
  }

  private async describe(row: OnboardingEntity): Promise<Onboarding> {
    const documents = await this.onboarding.listDocuments(row.merchantId);
    return {
      object: 'onboarding',
      merchant_id: row.merchantId,
      state: row.state,
      business_profile: row.profile(),
      representative: row.rep(),
      documents: documents.map((document) => document.toKycDocument()),
      requirements_due: requirementsDue(await this.factsFor(row)),
      staff_message: row.staffMessage,
      submitted_at: row.submittedAt ? row.submittedAt.toISOString() : null,
      decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
    };
  }
}

/**
 * A PATCH body's keys, minus the ones that were not sent. DTO instances carry every declared
 * field as an own property (ES2022 class fields), so a naive spread would null out the stored
 * profile with `undefined`. Blank strings clear a field, like `null`.
 */
function cleanPatch<T extends Partial<Record<keyof T, string | null>>>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key] as string | null | undefined;
    if (value === undefined) continue;
    const trimmed = value === null ? null : value.trim();
    out[key] = (trimmed === '' ? null : trimmed) as T[keyof T];
  }
  return out;
}

function decodeDocument(base64: string): Buffer {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > KYC_DOCUMENT_MAX_BYTES) {
    throw new ValidationException('Documents must be between 1 byte and 600 KB', [
      { path: 'content_base64', code: 'size', message: `decoded size ${bytes.length} bytes, maximum ${KYC_DOCUMENT_MAX_BYTES}` },
    ]);
  }
  return bytes;
}

/** Display name only — never part of a storage key. No path separators, no control characters. */
function safeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = filename.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'document';
}
