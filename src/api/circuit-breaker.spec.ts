import {
  CircuitBreakerRegistry,
  DEFAULT_BREAKER_OPTIONS,
} from 'src/api/circuit-breaker';
import { LegacyBillingUnavailableException } from 'src/common/errors/upstream.exceptions';

/**
 * One circuit per upstream, held in a registry.
 *
 * A breaker constructed per call is a breaker that never opens. That mistake was made
 * once, in month 4, and cost payzeno-api a 40-minute outage riding a legacy-biller
 * outage that should have been a 502 in 30ms — so the first thing this spec asserts is
 * that two calls under the same name share one circuit.
 */
describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;

  const fastOptions = {
    errorThresholdPercentage: 50,
    volumeThreshold: 2,
    resetTimeoutMs: 50,
    timeoutMs: 200,
  };

  const onOpen = () => new LegacyBillingUnavailableException('listInvoices', true);

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
  });

  it('runs the guarded function and returns its value', async () => {
    await expect(registry.run('billing-legacy', async () => 'ok', onOpen)).resolves.toBe('ok');
  });

  it('propagates a business failure untouched while the circuit is closed', async () => {
    await expect(
      registry.run('billing-legacy', async () => {
        throw new Error('invoice not found');
      }, onOpen),
    ).rejects.toThrow('invoice not found');
  });

  it('reuses one circuit per name across calls', async () => {
    await registry.run('billing-legacy', async () => 'a', onOpen);
    await registry.run('billing-legacy', async () => 'b', onOpen);

    expect(registry.snapshot().filter((s) => s.name === 'billing-legacy')).toHaveLength(1);
  });

  it('keeps circuits for different upstreams apart', async () => {
    await registry.run('billing-legacy', async () => 'a', onOpen);
    await registry.run('acquirer:worldflow', async () => 'b', onOpen);

    expect(registry.snapshot().map((s) => s.name).sort()).toEqual([
      'acquirer:worldflow',
      'billing-legacy',
    ]);
  });

  it('counts successes in the snapshot', async () => {
    await registry.run('billing-legacy', async () => 'ok', onOpen, fastOptions);
    await registry.run('billing-legacy', async () => 'ok', onOpen, fastOptions);

    const [snapshot] = registry.snapshot();
    expect(snapshot.successes).toBeGreaterThanOrEqual(2);
    expect(snapshot.state).toBe('closed');
  });

  it('opens after the failure threshold and then rejects without calling through', async () => {
    const upstream = jest.fn().mockRejectedValue(new Error('upstream down'));

    for (let i = 0; i < 6; i += 1) {
      await registry
        .run('billing-legacy', upstream as () => Promise<unknown>, onOpen, fastOptions)
        .catch(() => undefined);
    }

    const callsBefore = upstream.mock.calls.length;

    await expect(
      registry.run('billing-legacy', upstream as () => Promise<unknown>, onOpen, fastOptions),
    ).rejects.toBeInstanceOf(LegacyBillingUnavailableException);

    // The point of a breaker: the upstream is not touched at all once it is open.
    expect(upstream.mock.calls.length).toBe(callsBefore);
  });

  it('surfaces the caller’s exception on an open circuit, not a generic one', async () => {
    const upstream = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < 6; i += 1) {
      await registry
        .run('billing-legacy', upstream as () => Promise<unknown>, onOpen, fastOptions)
        .catch(() => undefined);
    }

    // A generic 502 here would lose `legacy_upstream_unavailable`, which the console renders.
    await expect(
      registry.run('billing-legacy', async () => 'never', onOpen, fastOptions),
    ).rejects.toBeInstanceOf(LegacyBillingUnavailableException);
  });

  it('reports isOpen for a tripped circuit and false for an unknown name', async () => {
    const upstream = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < 6; i += 1) {
      await registry
        .run('billing-legacy', upstream as () => Promise<unknown>, onOpen, fastOptions)
        .catch(() => undefined);
    }

    expect(registry.isOpen('billing-legacy')).toBe(true);
    expect(registry.isOpen('never-used')).toBe(false);
  });

  it('half-opens after the reset timeout and closes again on a success', async () => {
    const upstream = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < 6; i += 1) {
      await registry
        .run('billing-legacy', upstream as () => Promise<unknown>, onOpen, fastOptions)
        .catch(() => undefined);
    }
    expect(registry.isOpen('billing-legacy')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(
      registry.run('billing-legacy', async () => 'recovered', onOpen, fastOptions),
    ).resolves.toBe('recovered');
    expect(registry.isOpen('billing-legacy')).toBe(false);
  });

  describe('DEFAULT_BREAKER_OPTIONS', () => {
    it('matches api-surface.md §13 — 50% over 20 requests, 30s reset', () => {
      expect(DEFAULT_BREAKER_OPTIONS).toEqual({
        errorThresholdPercentage: 50,
        volumeThreshold: 20,
        resetTimeoutMs: 30_000,
        timeoutMs: 15_000,
      });
    });
  });

  it('snapshots an empty registry as an empty list', () => {
    expect(registry.snapshot()).toEqual([]);
  });
});
