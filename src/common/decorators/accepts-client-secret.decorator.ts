/**
 * `@AcceptsClientSecret()` — this handler may also be reached with a PaymentIntent client
 * secret (`pi_…_secret_…`), the browser's credential.
 *
 * `ClientSecretGuard` sits in the controller's guard chain AHEAD of `MerchantScopeGuard`, so the
 * scope check always sees whichever principal authenticated, and it ignores a client secret on
 * every handler that does not carry this. A method-level `@UseGuards(ClientSecretGuard)` cannot
 * do that job: Nest runs controller guards first, so the scope check would run before the guard
 * that produces the principal.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const ACCEPTS_CLIENT_SECRET_KEY = 'payzeno:accepts_client_secret';

export const AcceptsClientSecret = (): CustomDecorator => SetMetadata(ACCEPTS_CLIENT_SECRET_KEY, true);
