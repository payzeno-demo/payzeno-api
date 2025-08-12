import { NoopLogger, describeError, legacyLog } from 'src/common/logging/logger';
import type { PayzenoLogger } from 'src/common/logging/logger';
import { REDACTED, redactLogContext } from 'src/common/redaction/redaction.denylist';

/**
 * The logger seam. `PinoPayzenoLogger` is production; `NoopLogger` is the second
 * implementation — used by `ScheduledJob`'s dry-run mode and by every unit spec in the
 * repo, which is why it has to be a real, complete implementation rather than a stub.
 *
 * `legacyLog` is the month-1 shim. It is still exported, still has three call sites in
 * `src/meta/` and `src/health/`, and is still deprecated. It is tested because it ships.
 */
describe('NoopLogger', () => {
  let logger: PayzenoLogger;

  beforeEach(() => {
    logger = new NoopLogger();
  });

  it('implements every method of the PayzenoLogger interface', () => {
    for (const method of ['debug', 'info', 'warn', 'error', 'child'] as const) {
      expect(typeof (logger as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('swallows every level without throwing', () => {
    expect(() => {
      logger.debug('d', { a: 1 });
      logger.info('i', { a: 1 });
      logger.warn('w', { a: 1 });
      logger.error('e', new Error('boom'), { a: 1 });
    }).not.toThrow();
  });

  it('accepts a call with no context', () => {
    expect(() => logger.info('no context')).not.toThrow();
  });

  it('accepts an error of any shape', () => {
    expect(() => logger.error('e', 'a string, not an Error')).not.toThrow();
    expect(() => logger.error('e', undefined)).not.toThrow();
    expect(() => logger.error('e', { code: 'ECONNRESET' })).not.toThrow();
  });

  it('returns a logger from child(), so bindings chain', () => {
    const child = logger.child({ merchant_id: 'mch_1' });

    expect(typeof child.info).toBe('function');
    expect(() => child.child({ more: 'bindings' }).info('nested')).not.toThrow();
  });

  it('is spy-able — every service spec asserts on it', () => {
    const spy = jest.spyOn(logger, 'warn');

    logger.warn('SERVER_SIDE_TOKENISATION', { staff_id: 'stf_1' });

    expect(spy).toHaveBeenCalledWith('SERVER_SIDE_TOKENISATION', { staff_id: 'stf_1' });
  });
});

describe('describeError', () => {
  it('flattens an Error into a log context', () => {
    const ctx = describeError(new TypeError('bad input'));

    expect(ctx.err_name).toBe('TypeError');
    expect(ctx.err_message).toBe('bad input');
    expect(ctx.err_stack).toEqual(expect.any(String));
  });

  it('handles a non-Error throw', () => {
    const ctx = describeError('just a string');

    expect(ctx.err_name).toBe('unknown');
    expect(ctx.err_message).toBe('just a string');
    expect(ctx.err_stack).toBeNull();
  });

  it('handles null and undefined', () => {
    expect(describeError(null).err_message).toBe('null');
    expect(describeError(undefined).err_message).toBe('undefined');
  });

  it('produces only LogContext-legal value types', () => {
    for (const value of Object.values(describeError(new Error('x')))) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value);
    }
  });
});

describe('legacyLog', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes one JSON line', () => {
    legacyLog('info', 'meta currencies served');

    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    expect(() => JSON.parse(written[0])).not.toThrow();
  });

  it('marks the line as legacy, so the log pipeline can count the remaining call sites', () => {
    legacyLog('warn', 'readyz degraded', { ledger: false });

    const parsed = JSON.parse(written[0]);
    expect(parsed.legacy).toBe(true);
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('readyz degraded');
    expect(parsed.ledger).toBe(false);
  });

  it('stamps a timestamp', () => {
    legacyLog('info', 'x');

    expect(Date.parse(JSON.parse(written[0]).ts)).not.toBeNaN();
  });

  it('works with no context', () => {
    expect(() => legacyLog('info', 'bare')).not.toThrow();
  });
});

describe('redactLogContext', () => {
  it('redacts a denied key in a log context', () => {
    expect(redactLogContext({ api_key: 'sk_live_secret', merchant_id: 'mch_1' })).toEqual({
      api_key: REDACTED,
      merchant_id: 'mch_1',
    });
  });

  it('leaves an ordinary context untouched', () => {
    const ctx = { merchant_id: 'mch_1', status: 200, livemode: true };

    expect(redactLogContext(ctx)).toEqual(ctx);
  });

  it('is case-insensitive on the key', () => {
    expect(redactLogContext({ Client_Secret: 'pi_1_secret_x' }).Client_Secret).toBe(REDACTED);
  });
});
