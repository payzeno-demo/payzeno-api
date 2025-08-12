/**
 * The production PayzenoLogger.
 *
 * Every line carries service, version, request id and correlation id without the caller
 * passing them — they come off the AsyncLocalStorage context. Bodies never reach here: the
 * redaction pass runs on the way in (RedactionInterceptor) and this logger only ever sees a
 * flat LogContext, which it scrubs once more against the denylist before writing.
 */
import { Inject, Injectable } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { redactLogContext } from '../redaction/redaction.denylist';

import { describeError, type LogContext, type PayzenoLogger } from './logger';
import { currentCorrelationId, currentRequestId } from './request-context';

@Injectable()
export class PinoPayzenoLogger implements PayzenoLogger {
  private readonly pino: PinoLogger;
  private readonly redactPan: boolean;

  constructor(@Inject(API_CONFIG) config: ApiConfig, root?: PinoLogger) {
    this.redactPan = config.flags.redactPanInLogs;
    this.pino =
      root ??
      pino({
        level: config.runtime.logLevel,
        base: {
          service: config.runtime.serviceName,
          version: config.runtime.serviceVersion,
          env: config.runtime.nodeEnv,
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        messageKey: 'msg',
      });
  }

  private enrich(ctx: LogContext = {}): LogContext {
    const merged: LogContext = {
      ...ctx,
      request_id: currentRequestId(),
      correlation_id: currentCorrelationId(),
    };
    return this.redactPan ? redactLogContext(merged) : merged;
  }

  debug(msg: string, ctx?: LogContext): void {
    this.pino.debug(this.enrich(ctx), msg);
  }

  info(msg: string, ctx?: LogContext): void {
    this.pino.info(this.enrich(ctx), msg);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.pino.warn(this.enrich(ctx), msg);
  }

  error(msg: string, err?: unknown, ctx?: LogContext): void {
    this.pino.error(this.enrich({ ...ctx, ...(err ? describeError(err) : {}) }), msg);
  }

  child(bindings: LogContext): PayzenoLogger {
    const child = new PinoPayzenoLogger(
      { flags: { redactPanInLogs: this.redactPan } } as ApiConfig,
      this.pino.child(bindings),
    );
    return child;
  }
}
