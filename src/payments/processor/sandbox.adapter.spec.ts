import { SandboxProcessorAdapter } from 'src/payments/processor/sandbox.adapter';
import type { AuthorizeRequest } from 'src/payments/processor/processor.types';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * `SandboxProcessorAdapter` is production code that only test-mode principals reach
 * (blueprint §9.2). It makes no network call at all: the amount's last two minor units
 * decide the outcome, so a merchant integrating against test mode can reproduce every
 * decline code and the SCA challenge without an acquirer sandbox account.
 */
describe('SandboxProcessorAdapter', () => {
  let clock: FixedClock;
  let adapter: SandboxProcessorAdapter;

  function req(amountMinor: number, overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
    return {
      chargeId: 'ch_sbx000000001',
      merchantId: 'mch_sbx01',
      amountMinor,
      currency: 'GBP',
      paymentMethodToken: 'pmt_visa_4242',
      captureMethod: 'automatic',
      statementDescriptor: 'SANDBOX',
      threeDSecure: null,
      idempotencyKey: 'auth:ch_sbx000000001',
      ...overrides,
    };
  }

  beforeEach(() => {
    clock = new FixedClock('2026-01-15T12:00:00.000Z');
    adapter = new SandboxProcessorAdapter(clock);
  });

  it('reports worldflow as its acquirer', () => {
    // charge.acquirer is `not null` and typed Acquirer; a third enum member would leak
    // the sandbox into the settlement projection and into uq_charge_processor_reference.
    expect(adapter.acquirer).toBe('worldflow');
  });

  it('approves an amount with no trigger suffix', async () => {
    const result = await adapter.authorize(req(4_500));

    expect(result.approved).toBe(true);
    expect(result.declineCode).toBeNull();
    expect(result.authorizationCode).toEqual(expect.any(String));
    expect(result.networkTransactionId).toEqual(expect.any(String));
  });

  it.each([
    [4_501, 'do_not_honor'],
    [4_502, 'insufficient_funds'],
    [4_505, 'expired_card'],
    [4_509, 'velocity_exceeded'],
    [4_510, 'fraud_suspected'],
  ])('declines an amount ending %d with %s', async (amount, expected) => {
    const result = await adapter.authorize(req(amount));

    expect(result.approved).toBe(false);
    expect(result.declineCode).toBe(expected);
    expect(result.networkTransactionId).toBeNull();
    expect(result.authorizationCode).toBeNull();
  });

  it('raises the risk score on the fraud trigger', async () => {
    const clean = await adapter.authorize(req(4_500));
    const fraud = await adapter.authorize(req(4_510));

    expect(clean.riskScore).toBeLessThan(fraud.riskScore);
    expect(fraud.riskScore).toBeGreaterThanOrEqual(90);
  });

  it('forces an SCA challenge on the ..11 trigger', async () => {
    const result = await adapter.authorize(req(4_511));

    expect(result.approved).toBe(false);
    expect(result.threeDSecure?.authenticationFlow).toBe('challenge');
    expect(result.threeDSecure?.liabilityShifted).toBe(false);
  });

  it('reports a frictionless authentication with liability shift otherwise', async () => {
    const result = await adapter.authorize(req(4_500));

    expect(result.threeDSecure?.authenticationFlow).toBe('frictionless');
    expect(result.threeDSecure?.liabilityShifted).toBe(true);
  });

  it('produces a deterministic reference from the charge id', async () => {
    const a = await adapter.authorize(req(4_500));
    const b = await adapter.authorize(req(4_500));

    expect(a.processorReference).toBe(b.processorReference);
    expect(a.processorReference).toMatch(/^SBX-/);
  });

  it('never returns a live-looking acquirer reference', async () => {
    const result = await adapter.authorize(req(4_500));

    expect(result.processorReference.startsWith('wf_')).toBe(false);
    expect(result.processorReference.startsWith('np_')).toBe(false);
  });

  it('derives the card expiry from the injected clock', async () => {
    const result = await adapter.authorize(req(4_500));
    expect(result.card.exp_year).toBe(2028);

    const later = new SandboxProcessorAdapter(new FixedClock('2030-06-01T00:00:00.000Z'));
    const laterResult = await later.authorize(req(4_500));
    expect(laterResult.card.exp_year).toBe(2032);
  });

  it('captures whatever it is asked to', async () => {
    const result = await adapter.capture({
      networkTransactionId: 'sbxntid_1',
      amountMinor: 4_500,
      currency: 'GBP',
      idempotencyKey: 'capture:1',
    });

    expect(result.captured).toBe(true);
    expect(result.capturedAmountMinor).toBe(4_500);
    expect(result.capturedAt).toBe(clock.nowIso());
  });

  it('voids and refunds without a network round trip', async () => {
    await expect(
      adapter.void({ networkTransactionId: 'sbxntid_1', idempotencyKey: 'v1' }),
    ).resolves.toMatchObject({ voided: true });

    await expect(
      adapter.refund({
        networkTransactionId: 'sbxntid_1',
        amountMinor: 500,
        currency: 'GBP',
        reason: 'duplicate',
        idempotencyKey: 'r1',
      }),
    ).resolves.toMatchObject({ refunded: true, failureReason: null });
  });

  it('is always healthy', async () => {
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });
});
