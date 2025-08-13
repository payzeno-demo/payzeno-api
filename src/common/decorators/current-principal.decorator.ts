/**
 * `@CurrentPrincipal()` — the AuthPrincipal a guard attached to the request.
 *
 * ~45 application sites: every controller method that is not `public`. Reading
 * `req.principal` directly in a handler is a review rejection; the decorator is what makes
 * "which handlers are authenticated" a query rather than a grep.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthPrincipal } from '@payzeno/contracts';

import { AuthenticationRequiredException } from '../errors/auth.exceptions';

export interface RequestWithPrincipal {
  principal?: AuthPrincipal;
}

export const CurrentPrincipal = createParamDecorator(
  (field: keyof AuthPrincipal | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;

    // A guard that ran and did not attach is a wiring bug, but it must not become a 500.
    if (!principal) throw new AuthenticationRequiredException();

    return field ? (principal as Record<string, unknown>)[field] : principal;
  },
);
