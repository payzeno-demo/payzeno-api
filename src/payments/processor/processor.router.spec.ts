import { ProcessorUnavailableException } from 'src/common/errors/upstream.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { ProcessorAdapter } from 'src/payments/processor/processor.adapter';
import { ProcessorRouter } from 'src/payments/processor/processor.router';
import { SandboxProcessorAdapter } from 'src/payments/processor/sandbox.adapter';

import { FixedClock } from 'test/support/fixed-clock';
import { makeMerchant } from 'test/factories/merchant.factory';

/**
 * `ProcessorRouter.select(merchant, currency, ctx)` — frame 5 of the deepest chain in the
 * repo. The rules are ordered and the order matters: test-mode wins over everything, then
 * currency support, then the configured default.
 *
 * There is deliberately no health-based failover (ADR 0006). The spec below asserts that
 * absence, because "add failover" is the single most plausible well-meaning change
 * someone could make to this file, and it produces two authorisations on one card.
 */
describe('ProcessorRouter', () => {
  function adapter(acquirer: 'worldflow' | 'nordpay', healthy = true): ProcessorAdapter {
    return {
      acquirer,
      authorize: jest.fn(),
      capture: jest.fn(),
      void: jest.fn(),
      refund: jest.fn(),
      parseWebhook: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue(healthy),
    } as unknown as ProcessorAdapter;
  }

  let worldflow: ProcessorAdapter;
  let nordpay: ProcessorAdapter;
  let sandbox: SandboxProcessorAdapter;
  let router: ProcessorRouter;

  beforeEach(() => {
    worldflow = adapter('worldflow');
    nordpay = adapter('nordpay');
    sandbox = new SandboxProcessorAdapter(new FixedClock());
    router = new ProcessorRouter([worldflow, nordpay], sandbox, new NoopLogger(), 'worldflow');
  });

  const merchant = makeMerchant();

  describe('select', () => {
    it('routes USD to the configured default', () => {
      expect(router.select(merchant, 'USD')).toBe(worldflow);
    });

    it('routes ILS to the configured default', () => {
      expect(router.select(merchant, 'ILS')).toBe(worldflow);
    });

    it('routes EUR to nordpay — worldflow does not hold SEPA', () => {
      expect(router.select(merchant, 'EUR')).toBe(nordpay);
    });

    it('routes GBP to nordpay', () => {
      expect(router.select(merchant, 'GBP')).toBe(nordpay);
    });

    it('routes every currency to the sandbox for a test-mode principal', () => {
      expect(router.select(merchant, 'USD', { livemode: false })).toBe(sandbox);
      expect(router.select(merchant, 'EUR', { livemode: false })).toBe(sandbox);
      expect(router.select(merchant, 'JPY', { livemode: false })).toBe(sandbox);
    });

    it('prefers the default acquirer when several support the currency', () => {
      const both = new ProcessorRouter([nordpay, worldflow], sandbox, new NoopLogger(), 'worldflow');

      expect(both.select(merchant, 'USD')).toBe(worldflow);
    });

    it('throws ProcessorUnavailableException when no acquirer supports the currency', () => {
      const nordpayOnly = new ProcessorRouter([nordpay], sandbox, new NoopLogger(), 'nordpay');

      expect(() => nordpayOnly.select(merchant, 'JPY')).toThrow(ProcessorUnavailableException);
    });

    it('logs when it routes off the default rather than doing it silently', () => {
      const logger = new NoopLogger();
      const spy = jest.spyOn(logger, 'info');
      const r = new ProcessorRouter([worldflow, nordpay], sandbox, logger, 'worldflow');

      r.select(merchant, 'EUR');

      expect(spy).toHaveBeenCalledWith('acquirer_routed_off_default', expect.objectContaining({
        currency: 'EUR',
        chosen: 'nordpay',
        default: 'worldflow',
      }));
    });

    it('is deterministic — the same merchant and currency always route the same way', () => {
      // Not academic: a router that load-balanced would break
      // uq_charge_processor_reference, because a retried authorisation would land on a
      // different acquirer with a different reference space.
      expect(router.select(merchant, 'GBP')).toBe(router.select(merchant, 'GBP'));
    });

    it('does not consult healthCheck at all', async () => {
      router.select(merchant, 'EUR');

      expect(nordpay.healthCheck).not.toHaveBeenCalled();
      expect(worldflow.healthCheck).not.toHaveBeenCalled();
    });
  });

  describe('forAcquirer', () => {
    it('resolves the acquirer that holds an existing authorisation', () => {
      expect(router.forAcquirer('nordpay')).toBe(nordpay);
      expect(router.forAcquirer('worldflow')).toBe(worldflow);
    });

    it('returns the sandbox for a test-mode context', () => {
      expect(router.forAcquirer('nordpay', { livemode: false })).toBe(sandbox);
    });

    it('throws when the acquirer is not configured', () => {
      const worldflowOnly = new ProcessorRouter([worldflow], sandbox, new NoopLogger(), 'worldflow');

      expect(() => worldflowOnly.forAcquirer('nordpay')).toThrow(ProcessorUnavailableException);
    });
  });

  describe('health', () => {
    it('reports one line per configured acquirer', async () => {
      await expect(router.health()).resolves.toEqual({ worldflow: true, nordpay: true });
    });

    it('reports a degraded acquirer without throwing', async () => {
      const sick = adapter('nordpay', false);
      const r = new ProcessorRouter([worldflow, sick], sandbox, new NoopLogger(), 'worldflow');

      await expect(r.health()).resolves.toEqual({ worldflow: true, nordpay: false });
    });
  });
});
