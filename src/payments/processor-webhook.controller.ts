/**
 * `POST /v1/processor/webhooks/:acquirer` — api-surface.md §9, the `webhook-sig` auth row.
 *
 * The only unauthenticated-by-principal route in the repo: the caller is an acquirer, it has
 * no api key and no session, and the credential is the HMAC over the raw body.
 *
 * Two things this handler does that look odd and are not:
 *
 *   1. It reads the RAW body (`@Req()` + `rawBody`), not the parsed one. `JSON.parse` followed
 *      by `JSON.stringify` does not round-trip byte-for-byte — key order and unicode escapes
 *      both move — and the HMAC is over bytes. Signature verification against a re-serialised
 *      body fails intermittently and looks like an acquirer problem for about three weeks.
 *   2. It answers `202` before the work is durable? No — it awaits. An acquirer that gets a
 *      2xx will not resend, so a fire-and-forget here loses disputes. The 202 is the contract's
 *      status code, not a promise of async.
 */

import { Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { Acquirer } from '@payzeno/contracts';

import { ProcessorSignatureGuard } from '../auth/guards/processor-signature.guard';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { Inject } from '@nestjs/common';
import { ProcessorWebhookService } from './processor-webhook.service';

/** Express does not expose the raw body unless the JSON parser was told to keep it. */
type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('v1/processor/webhooks')
export class ProcessorWebhookController {
  constructor(
    private readonly webhooks: ProcessorWebhookService,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * `@RateLimit(600, 60)` — an acquirer replaying a day's file after an outage is a legitimate
   * burst, and the limit is set above what either of ours can produce. It exists to stop a
   * misconfigured sandbox, not to throttle the real thing.
   */
  @Post(':acquirer')
  @HttpCode(202)
  @UseGuards(ProcessorSignatureGuard)
  @RateLimit(600, 60)
  async receive(@Param('acquirer') acquirer: Acquirer, @Req() req: RawBodyRequest): Promise<void> {
    const signature = String(req.headers['x-payzeno-signature'] ?? '');
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    this.logger.debug('processor_webhook_received', {
      acquirer,
      body_bytes: rawBody.byteLength,
      has_signature: signature.length > 0,
      // Never the body: acquirer payloads carry a masked PAN in `card.display_number` and the
      // redaction interceptor does not reach a Buffer.
      raw_body_logged: false,
    });

    await this.webhooks.handle(acquirer, rawBody, signature);
  }
}
