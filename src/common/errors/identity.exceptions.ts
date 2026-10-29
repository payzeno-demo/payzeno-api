/**
 * Refusals from the identity flows of RFC platform-v2 §3-§4: emailed links and onboarding.
 *
 * Both reuse existing contract codes — the console already branches on `invalid_request` and
 * `invalid_state` — and say which case it is in `details.reason`, which is what the console's
 * "this link has expired, request a new one" copy keys on.
 */
import type { ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export type LinkTokenFailure = 'token_invalid' | 'token_expired';

/**
 * 400. A verify / invite / reset link that does not resolve. Unknown, already used, superseded
 * by a newer link and issued for a different flow are all `token_invalid` — distinguishing them
 * would tell a guesser which strings were once real.
 */
export class InvalidLinkTokenException extends ApiException {
  readonly code: ErrorCode = 'invalid_request';
  readonly httpStatus = 400;

  constructor(readonly reason: LinkTokenFailure) {
    super(
      reason === 'token_expired'
        ? 'This link has expired. Request a new one.'
        : 'This link is invalid or has already been used.',
      { reason },
    );
  }
}

/** 409. `POST /v1/onboarding/submit` with requirements still due. */
export class OnboardingIncompleteException extends ApiException {
  readonly code: ErrorCode = 'invalid_state';
  readonly httpStatus = 409;

  constructor(requirementsDue: readonly string[]) {
    super(`Onboarding cannot be submitted yet: ${requirementsDue.join(', ')} still due`, {
      reason: 'requirements_due',
      requirements_due: requirementsDue.join(','),
    });
  }
}
