/**
 * What is still missing before a merchant may submit for review — `Onboarding.requirements_due`.
 *
 * L5, pure: the service gathers the facts (the stored profile, whether a bank account exists,
 * which document types were uploaded) and this turns them into the contract's list. The
 * console renders the checklist from it and `submit` refuses while it is non-empty, so the two
 * can never disagree about what "done" means.
 *
 *   business_profile   type, what you sell, support email and a postal address; a registration
 *                      number too unless the business is an individual. Website is optional —
 *                      plenty of real merchants sell through a marketplace and have none.
 *   representative     the person accountable: name, date of birth, email.
 *   bank_account       any bank account not already known to be unusable. Validation by the
 *                      vault is asynchronous and the reviewer looks at it anyway.
 *   identity_document  at least one `identity_document` upload.
 */
import type {
  BankAccountStatus,
  BusinessProfile,
  KycDocumentType,
  OnboardingRequirement,
  Representative,
} from '@payzeno/contracts';

export interface OnboardingFacts {
  profile: BusinessProfile;
  representative: Representative;
  bankAccountStatuses: readonly BankAccountStatus[];
  documentTypes: ReadonlySet<KycDocumentType>;
}

const UNUSABLE_BANK_STATUSES: ReadonlySet<BankAccountStatus> = new Set(['verification_failed', 'errored']);

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function businessProfileComplete(profile: BusinessProfile): boolean {
  const base =
    profile.business_type !== null &&
    filled(profile.product_description) &&
    filled(profile.support_email) &&
    filled(profile.address_line1) &&
    filled(profile.city) &&
    filled(profile.postal_code);

  return base && (profile.business_type === 'individual' || filled(profile.registration_number));
}

export function representativeComplete(representative: Representative): boolean {
  return filled(representative.full_name) && filled(representative.date_of_birth) && filled(representative.email);
}

export function requirementsDue(facts: OnboardingFacts): OnboardingRequirement[] {
  const due: OnboardingRequirement[] = [];

  if (!businessProfileComplete(facts.profile)) due.push('business_profile');
  if (!representativeComplete(facts.representative)) due.push('representative');
  if (!facts.bankAccountStatuses.some((status) => !UNUSABLE_BANK_STATUSES.has(status))) due.push('bank_account');
  if (!facts.documentTypes.has('identity_document')) due.push('identity_document');

  return due;
}
