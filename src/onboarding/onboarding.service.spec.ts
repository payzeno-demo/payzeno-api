import type { EntityManager } from 'typeorm';

import { ValidationException } from 'src/common/errors/api.exception';
import { OnboardingIncompleteException } from 'src/common/errors/identity.exceptions';
import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { BankAccountRepository } from 'src/merchants/bank-accounts/bank-accounts.service';
import type { MerchantMailerService } from 'src/merchants/merchant-mailer.service';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import type { MerchantsService } from 'src/merchants/merchants.service';
import type { KycDocumentEntity } from 'src/onboarding/kyc-document.entity';
import type { KycStorageClient } from 'src/onboarding/kyc-storage-http.client';
import { OnboardingEntity } from 'src/onboarding/onboarding.entity';
import type { OnboardingRepository } from 'src/onboarding/onboarding.repository';
import { OnboardingService } from 'src/onboarding/onboarding.service';
import { OnboardingStateMachine } from 'src/onboarding/state/onboarding.state-machine';
import type { StaffAuditService } from 'src/staff/staff-audit.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * RFC platform-v2 §3. The merchant fills in, uploads and submits; staff decide; and
 * `merchant.status` follows only through `MerchantsService.changeStatus`, inside the decision's
 * transaction together with the staff audit row and the email.
 */
describe('OnboardingService', () => {
  const clock = new FixedClock('2026-05-02T11:30:00.000Z');
  const manager = { tx: true } as unknown as EntityManager;
  const staff = { staffId: 'stf_01HZSTAFF0000000000000001', ip: '198.51.100.4' };

  let row: OnboardingEntity;
  let repo: {
    findByMerchant: jest.Mock;
    insertIfMissing: jest.Mock;
    lockForMerchant: jest.Mock;
    saveLocked: jest.Mock;
    appendDocument: jest.Mock;
    listDocuments: jest.Mock;
    documentTypes: jest.Mock;
    findDocument: jest.Mock;
  };
  let storage: { put: jest.Mock; get: jest.Mock };
  let bankAccountRows: Array<{ status: string }>;
  let merchants: { findById: jest.Mock };
  let merchantsService: { changeStatus: jest.Mock };
  let mailer: { queueToAdmins: jest.Mock; consoleLink: jest.Mock };
  let staffAudit: { record: jest.Mock };
  let service: OnboardingService;

  function onboardingRow(overrides: Partial<OnboardingEntity> = {}): OnboardingEntity {
    const entity = new OnboardingEntity();
    Object.assign(entity, {
      id: 'onb_1',
      merchantId: TEST_MERCHANT_ID,
      state: 'collecting',
      businessProfile: {},
      representative: {},
      staffMessage: null,
      submittedAt: null,
      decidedAt: null,
      decidedBy: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...overrides,
    });
    return entity;
  }

  const completeProfile = {
    business_type: 'company' as const,
    product_description: 'Coffee',
    support_email: 'help@acme.example',
    address_line1: '1 Main St',
    city: 'Springfield',
    postal_code: '12345',
    registration_number: 'REG-1',
  };
  const completeRepresentative = { full_name: 'Ada', date_of_birth: '1980-01-01', email: 'ada@acme.example' };

  beforeEach(() => {
    row = onboardingRow();
    repo = {
      findByMerchant: jest.fn(async () => row),
      insertIfMissing: jest.fn(async () => undefined),
      lockForMerchant: jest.fn(async () => row),
      saveLocked: jest.fn(async () => undefined),
      appendDocument: jest.fn(async () => undefined),
      listDocuments: jest.fn(async () => []),
      documentTypes: jest.fn(async () => new Set()),
      findDocument: jest.fn(async () => null),
    };
    storage = { put: jest.fn(async () => undefined), get: jest.fn() };
    bankAccountRows = [];
    merchants = { findById: jest.fn(async () => ({ id: TEST_MERCHANT_ID, status: 'pending_review' })) };
    merchantsService = { changeStatus: jest.fn(async (_id: string, to: string) => ({ status: to })) };
    mailer = { queueToAdmins: jest.fn(async () => 1), consoleLink: jest.fn((path: string) => `http://console.test${path}`) };
    staffAudit = { record: jest.fn(async () => undefined) };

    service = new OnboardingService(
      repo as unknown as OnboardingRepository,
      new OnboardingStateMachine(),
      storage as unknown as KycStorageClient,
      { scopedQuery: () => ({ getMany: async () => bankAccountRows }) } as unknown as BankAccountRepository,
      merchants as unknown as MerchantRepository,
      merchantsService as unknown as MerchantsService,
      mailer as unknown as MerchantMailerService,
      staffAudit as unknown as StaffAuditService,
      { runInTransaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) => fn(manager)) } as unknown as TransactionManager,
      new IdFactory(),
      clock,
      new NoopLogger(),
    );
  });

  describe('get', () => {
    it('creates a collecting row the first time anybody looks', async () => {
      repo.findByMerchant.mockResolvedValueOnce(null).mockResolvedValueOnce(row);

      const onboarding = await service.get(TEST_MERCHANT_ID);

      const [inserted] = repo.insertIfMissing.mock.calls[0] as [OnboardingEntity];
      expect(inserted).toMatchObject({ merchantId: TEST_MERCHANT_ID, state: 'collecting' });
      expect(inserted.id).toBe(`onb_${TEST_MERCHANT_ID.slice(4)}`);
      expect(onboarding.state).toBe('collecting');
    });

    it('answers the contract shape, with every requirement due on a fresh row', async () => {
      const onboarding = await service.get(TEST_MERCHANT_ID);

      expect(onboarding).toMatchObject({
        object: 'onboarding',
        merchant_id: TEST_MERCHANT_ID,
        business_profile: { business_type: null, website: null },
        representative: { full_name: null },
        documents: [],
        requirements_due: ['business_profile', 'representative', 'bank_account', 'identity_document'],
        staff_message: null,
      });
    });
  });

  describe('update', () => {
    it('merges only the keys that were sent, trimmed, and clears blanks', async () => {
      row.businessProfile = { website: 'https://old.example', city: 'Springfield' };

      await service.update(TEST_MERCHANT_ID, {
        business_profile: { city: ' Shelbyville ', website: '  ', support_email: undefined },
        representative: { full_name: 'Ada' },
      });

      expect(repo.saveLocked).toHaveBeenCalledWith(row, manager);
      expect(row.businessProfile).toEqual({ website: null, city: 'Shelbyville' });
      expect(row.representative).toEqual({ full_name: 'Ada' });
    });

    it('refuses while a reviewer has the application', async () => {
      row.state = 'submitted';

      await expect(service.update(TEST_MERCHANT_ID, { representative: { full_name: 'Ada' } })).rejects.toBeInstanceOf(
        InvalidStateTransitionException,
      );
      expect(repo.saveLocked).not.toHaveBeenCalled();
    });
  });

  describe('uploadDocument', () => {
    const pdf = Buffer.from('%PDF-1.4 passport scan');

    it('puts the bytes under an id-only key and records the metadata', async () => {
      const document = await service.uploadDocument(
        TEST_MERCHANT_ID,
        { type: 'identity_document', filename: '../../etc/passport.pdf', content_type: 'application/pdf', content_base64: pdf.toString('base64') },
        'usr_1',
      );

      const [key, bytes, contentType] = storage.put.mock.calls[0] as [string, Buffer, string];
      expect(key).toBe(`merchants/${TEST_MERCHANT_ID}/kyc/${document.id}`);
      expect(bytes.equals(pdf)).toBe(true);
      expect(contentType).toBe('application/pdf');

      const [stored] = repo.appendDocument.mock.calls[0] as [KycDocumentEntity];
      expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.uploadedBy).toBe('usr_1');
      expect(document).toMatchObject({
        object: 'kyc_document',
        type: 'identity_document',
        filename: '.._.._etc_passport.pdf',
        size_bytes: pdf.length,
      });
      expect(document.id).toMatch(/^kyc_/);
    });

    it('refuses more than 600 KB decoded', async () => {
      const big = Buffer.alloc(600 * 1024 + 1, 1).toString('base64');

      await expect(
        service.uploadDocument(
          TEST_MERCHANT_ID,
          { type: 'identity_document', filename: 'big.pdf', content_type: 'application/pdf', content_base64: big },
          null,
        ),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('refuses after a decision', async () => {
      row.state = 'approved';

      await expect(
        service.uploadDocument(
          TEST_MERCHANT_ID,
          { type: 'identity_document', filename: 'a.pdf', content_type: 'application/pdf', content_base64: pdf.toString('base64') },
          null,
        ),
      ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    });
  });

  describe('submit', () => {
    it('refuses with 409 and the list while anything is due', async () => {
      const err = await service.submit(TEST_MERCHANT_ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(OnboardingIncompleteException);
      expect((err as OnboardingIncompleteException).toResponse('req').error.details).toMatchObject({
        reason: 'requirements_due',
        requirements_due: 'business_profile,representative,bank_account,identity_document',
      });
      expect(repo.saveLocked).not.toHaveBeenCalled();
    });

    it('moves a complete application to submitted and clears the last staff request', async () => {
      row.state = 'needs_info';
      row.staffMessage = 'Upload a clearer scan';
      row.businessProfile = completeProfile;
      row.representative = completeRepresentative;
      bankAccountRows = [{ status: 'new' }];
      repo.documentTypes.mockResolvedValue(new Set(['identity_document']));

      const onboarding = await service.submit(TEST_MERCHANT_ID);

      expect(row.state).toBe('submitted');
      expect(row.submittedAt).toEqual(clock.now());
      expect(row.staffMessage).toBeNull();
      expect(onboarding.requirements_due).toEqual([]);
    });
  });

  describe('decide', () => {
    beforeEach(() => {
      row.state = 'submitted';
    });

    it('approves: onboarding approved, merchant active, audited and emailed — one transaction', async () => {
      await service.decide(TEST_MERCHANT_ID, 'approve', null, staff);

      expect(row).toMatchObject({ state: 'approved', decidedAt: clock.now(), decidedBy: staff.staffId });
      expect(merchantsService.changeStatus).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'active',
        'onboarding approved',
        `staff:${staff.staffId}`,
        manager,
      );
      expect(staffAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          staffId: staff.staffId,
          actingMerchantId: TEST_MERCHANT_ID,
          action: 'onboarding.approve',
          before: { state: 'submitted', staff_message: null },
          after: { state: 'approved', staff_message: null, merchant_status: 'active' },
          ip: staff.ip,
        }),
        manager,
      );
      expect(mailer.queueToAdmins).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'onboarding_approved',
        { message: null, console_url: 'http://console.test/' },
        { manager },
      );
    });

    it('rejects with the reason shown to the merchant, and the merchant becomes rejected', async () => {
      await service.decide(TEST_MERCHANT_ID, 'reject', '  Prohibited business  ', staff);

      expect(row).toMatchObject({ state: 'rejected', staffMessage: 'Prohibited business' });
      expect(merchantsService.changeStatus).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'rejected',
        'Prohibited business',
        expect.any(String),
        manager,
      );
      expect(mailer.queueToAdmins.mock.calls[0][1]).toBe('onboarding_rejected');
    });

    it('asks for more without touching the merchant status, and links to the checklist', async () => {
      await service.decide(TEST_MERCHANT_ID, 'request-info', 'Upload a proof of address', staff);

      expect(row.state).toBe('needs_info');
      expect(merchantsService.changeStatus).not.toHaveBeenCalled();
      expect(mailer.queueToAdmins).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'onboarding_info_requested',
        { message: 'Upload a proof of address', console_url: 'http://console.test/onboarding' },
        { manager },
      );
    });

    it.each(['reject', 'request-info'] as const)('requires a message to %s', async (decision) => {
      await expect(service.decide(TEST_MERCHANT_ID, decision, '   ', staff)).rejects.toBeInstanceOf(ValidationException);
      expect(repo.saveLocked).not.toHaveBeenCalled();
    });

    it('does not reinstate a merchant risk restricted in the meantime', async () => {
      merchants.findById.mockResolvedValue({ id: TEST_MERCHANT_ID, status: 'restricted' });

      await service.decide(TEST_MERCHANT_ID, 'approve', null, staff);

      expect(merchantsService.changeStatus).not.toHaveBeenCalled();
      expect(staffAudit.record.mock.calls[0][0].after).toMatchObject({ merchant_status: 'restricted' });
    });

    it('refuses a decision on an application that was never submitted', async () => {
      row.state = 'collecting';

      await expect(service.decide(TEST_MERCHANT_ID, 'approve', null, staff)).rejects.toBeInstanceOf(
        InvalidStateTransitionException,
      );
      expect(mailer.queueToAdmins).not.toHaveBeenCalled();
    });
  });
});
