/**
 * `POST /v1/payment_intents/:id/confirm` body — `implements ConfirmPaymentIntentRequest`.
 *
 * Both fields are optional and that is the interesting part: the common case is a confirm with
 * an empty body, because the token was attached at create time. The token here is an override
 * for the "customer changed their card on the review screen" flow.
 *
 * `return_url` is validated as an https URL because it is where we send a cardholder mid-3DS.
 * An http return url downgrades the challenge and some issuers refuse the authentication
 * outright; a relative one sends them to our own domain, which is worse.
 */

import { IsOptional, IsUrl, MaxLength } from 'class-validator';

import type { ConfirmPaymentIntentRequest, PaymentMethodToken } from '@payzeno/contracts';
