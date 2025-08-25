/**
 * `POST /v1/payment_intents/:id/confirm` body — `implements ConfirmPaymentIntentRequest`.
 *
 * Both fields are optional and that is the interesting part: the common case is a confirm with
 * an empty body, because the token was attached at create time. The token here is an override
