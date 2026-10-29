import type { Merchant } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { EventPublisher } from 'src/events/publisher';
import { ChargeAuthorizationService, type AuthorizeChargeCommand } from 'src/payments/charge-authorization.service';
import type { ChargeExpiryPolicy } from 'src/payments/charge-expiry.policy';
import { ChargeEntity } from 'src/payments/charge.entity';
import type { AuthorizationWrite, ChargeRepository } from 'src/payments/charge.repository';
import type { ProcessorAdapter } from 'src/payments/processor/processor.adapter';
import type { ProcessorRouter } from 'src/payments/processor/processor.router';
import type { AuthorizeResult } from 'src/payments/processor/processor.types';
import type { VaultClient } from 'src/payments/vault/vault.client';
import type { RiskAssessment, RiskEngine } from 'src/risk/risk-engine.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const APPROVED: AuthorizeResult = {
  approved: true,
  pendingAuthentication: false,
  challengeUrl: null,
  networkTransactionId: 'WFT0000000001',
  authorizationCode: '123456',
  processorReference: 'WFT0000000001',
  declineCode: null,
  riskScore: 21,
  card: { brand: 'visa', last_four: '0422', exp_month: 12, exp_year: 2030, country: 'GB', funding: 'credit' },
  threeDSecure: null,
  raw: {},
};

/**
 * RFC platform-v2 §8 inside authorisation: the rules run on the issuer's approval, before it is
 * persisted, and a held payment's `payment.authorized` carries its review id.
 */
describe('ChargeAuthorizationService — risk', () => {
  let saved: ChargeEntity[];
  let authorizedWrites: AuthorizationWrite[];
  let published: Array<{ type: string; payload: Record<string, unknown> }>;
  let assess: jest.Mock<Promise<RiskAssessment>, [ChargeEntity, Merchant]>;

  function service(): ChargeAuthorizationService {
    const manager = stub<EntityManager>({
      create: jest.fn((_entity: unknown, fields: Partial<ChargeEntity>) => Object.assign(new ChargeEntity(), fields)) as EntityManager['create'],
      save: jest.fn(async (_entity: unknown, row: ChargeEntity) => {
        saved.push(row);
        return row;
      }) as EntityManager['save'],
    });
    return new ChargeAuthorizationService(
      stub<ChargeRepository>({
        markAuthorized: jest.fn(async (_m: EntityManager, _id: string, write: AuthorizationWrite) => {
          authorizedWrites.push(write);
        }),
      }),
      stub<ProcessorRouter>({
        select: () => stub<ProcessorAdapter>({ acquirer: 'worldflow', authorize: jest.fn(async () => APPROVED) }),
      }),
      stub<VaultClient>({
        resolve: jest.fn(async () => ({ token: 'pmt_1', fingerprint: 'fp_gb_card', card: APPROVED.card })),
      }),
      stub<ChargeExpiryPolicy>({ expiresAt: () => new Date('2026-11-05T09:00:00.000Z') }),
      stub<RiskEngine>({ assess }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(manager)) }),
      stub<IdFactory>({ chargeId: () => 'ch_1', opaque: (prefix: string) => `${prefix}01JBREVIEW0000000000000AAA` }),
      stub<EventPublisher>({
        publish: jest.fn(async (type: string, payload: Record<string, unknown>) => {
          published.push({ type, payload });
          return 'evt_1';
        }),
      }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  function command(overrides: Partial<AuthorizeChargeCommand> = {}): AuthorizeChargeCommand {
    return {
      merchant: stub<Merchant>({ id: 'mch_1', mcc: '5812', capture_at_settlement: false, reserve_bps: 0, created_at: '2026-10-26T00:00:00Z' }),
      paymentIntentId: 'pi_1',
      amountMinor: 30_000,
      currency: 'USD',
      paymentMethodToken: 'pmt_1',
      captureMethod: 'automatic',
      statementDescriptor: null,
      threeDSecure: null,
      livemode: true,
      correlationId: 'pi_1',
      shopper: { country: 'JP', ip: '126.0.0.9' },
      ...overrides,
    };
  }

  beforeEach(() => {
    saved = [];
    authorizedWrites = [];
    published = [];
    assess = jest.fn(async () => ({ outcome: 'review', rules: ['country_mismatch'], signals: stub<RiskAssessment['signals']>({}) }));
  });

  it('stores the fingerprint and the shopper on the pending charge, for the velocity rules', async () => {
    await service().authorize(command());
    expect(saved[0]).toMatchObject({ card_fingerprint: 'fp_gb_card', shopper_ip: '126.0.0.9', shopper_country: 'JP' });
  });

  it('judges the approval with the acquirer’s score and records the outcome', async () => {
    const outcome = await service().authorize(command());

    expect(assess.mock.calls[0][0].risk_score).toBe(21);
    expect(outcome.risk?.outcome).toBe('review');
    expect(authorizedWrites[0].riskOutcome).toBe('review');
  });

  it('mints the review id up front and puts it on payment.authorized', async () => {
    const outcome = await service().authorize(command());

    expect(outcome.reviewId).toBe('rv_01JBREVIEW0000000000000AAA');
    expect(published[0]).toMatchObject({ type: 'payment.authorized', payload: { review_id: outcome.reviewId } });
  });

  it('leaves review_id off an unheld authorisation, for ledgers that predate the field', async () => {
    assess.mockResolvedValue({ outcome: 'allow', rules: [], signals: stub<RiskAssessment['signals']>({}) });
    const outcome = await service().authorize(command());

    expect(outcome.reviewId).toBeNull();
    expect(published[0].payload).not.toHaveProperty('review_id');
  });

  it('skips the rules for an off-session renewal', async () => {
    const outcome = await service().authorize(command({ skipRisk: true }));

    expect(assess).not.toHaveBeenCalled();
    expect(outcome.risk).toBeNull();
    expect(authorizedWrites[0].riskOutcome).toBeNull();
  });
});
