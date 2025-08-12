/**
 * PayzenoLogger — the logging interface every service takes.
 *
 * Structured only. `LogContext` is deliberately flat scalars: the redaction pass has to be
 * able to walk it exhaustively, and a nested object is how a whole `CreateBankAccountRequest`
 * ended up in an access log (arc PCI, PAY-1740).
 *
 * Concretes: PinoPayzenoLogger (prod), NoopLogger (jobs --dry-run).
 */
export type LogContext = Record<string, string | number | boolean | null>;

export interface PayzenoLogger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, err?: unknown, ctx?: LogContext): void;
  child(bindings: LogContext): PayzenoLogger;
}

export const PAYZENO_LOGGER = Symbol('PAYZENO_LOGGER');

/**
 * @deprecated Month-1 shim from before PayzenoLogger existed. Three call sites remain, in
 * src/meta and src/health. Removing it needs a PR nobody has wanted to write.
 */
export function legacyLog(level: 'info' | 'warn', msg: string, ctx: LogContext = {}): void {
  const line = JSON.stringify({ level, msg, ...ctx, legacy: true, ts: new Date().toISOString() });
  process.stdout.write(`${line}\n`);
}

/** Wired by `jobs --dry-run` and by test-app.ts when a suite asserts on side effects only. */
export class NoopLogger implements PayzenoLogger {
  debug(): void {
    /* intentionally silent */
  }

  info(): void {
    /* intentionally silent */
  }

  warn(): void {
    /* intentionally silent */
  }

  error(): void {
    /* intentionally silent */
  }

  child(): PayzenoLogger {
    return this;
  }
}

/** Normalises whatever was thrown into something safe to serialise. */
export function describeError(err: unknown): LogContext {
  if (err instanceof Error) {
    return {
      err_name: err.name,
      err_message: err.message,
      err_stack: err.stack ?? null,
    };
  }
  return { err_name: 'unknown', err_message: String(err), err_stack: null };
}

/**
 * Alias for PAYZENO_LOGGER.
 *
 * Half the repo was written against `LOGGER` before the token was renamed in month 3 to stop
 * it colliding with Nest's own `Logger`. Renaming the remaining ~15 call sites is a
 * twenty-file diff nobody wants in their PR, so the old name stays as an alias and the two
 * resolve to the same provider. — dhotfix
 */
export const LOGGER = PAYZENO_LOGGER;
