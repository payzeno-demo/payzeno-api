import type { BusinessProfile, Representative } from '@payzeno/contracts';

import { requirementsDue, type OnboardingFacts } from 'src/onboarding/onboarding-requirements.policy';

/** What "ready to submit" means, in one place, for the console checklist and `submit` alike. */
describe('requirementsDue', () => {
  const profile: BusinessProfile = {
    business_type: 'company',
    website: null,
    product_description: 'Coffee',
    support_email: 'help@acme.example',
    address_line1: '1 Main St',
    city: 'Springfield',
    postal_code: '12345',
    registration_number: 'REG-1',
  };
  const representative: Representative = { full_name: 'Ada', date_of_birth: '1980-01-01', email: 'ada@acme.example' };

  function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
    return {
      profile,
      representative,
      bankAccountStatuses: ['new'],
      documentTypes: new Set(['identity_document']),
      ...overrides,
    };
  }

  it('is empty when everything is there — website is optional', () => {
    expect(requirementsDue(facts())).toEqual([]);
  });

  it('lists every requirement for a fresh signup, in contract order', () => {
    const empty: BusinessProfile = {
      business_type: null,
      website: null,
      product_description: null,
      support_email: null,
      address_line1: null,
      city: null,
      postal_code: null,
      registration_number: null,
    };
    expect(
      requirementsDue({
        profile: empty,
        representative: { full_name: null, date_of_birth: null, email: null },
        bankAccountStatuses: [],
        documentTypes: new Set(),
      }),
    ).toEqual(['business_profile', 'representative', 'bank_account', 'identity_document']);
  });

  it('needs a registration number from a company but not from an individual', () => {
    const unregistered = { ...profile, registration_number: null };

    expect(requirementsDue(facts({ profile: unregistered }))).toEqual(['business_profile']);
    expect(requirementsDue(facts({ profile: { ...unregistered, business_type: 'individual' } }))).toEqual([]);
  });

  it('treats a whitespace-only field as missing', () => {
    expect(requirementsDue(facts({ representative: { ...representative, full_name: '   ' } }))).toEqual(['representative']);
  });

  it('does not count a bank account already known to be unusable', () => {
    expect(requirementsDue(facts({ bankAccountStatuses: ['verification_failed', 'errored'] }))).toEqual(['bank_account']);
    expect(requirementsDue(facts({ bankAccountStatuses: ['errored', 'validated'] }))).toEqual([]);
  });

  it('wants an identity document specifically', () => {
    expect(requirementsDue(facts({ documentTypes: new Set(['proof_of_address']) }))).toEqual(['identity_document']);
  });
});
