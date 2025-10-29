# Runbook — webhook delivery

Owner: apager. Code: `src/webhooks/`, `src/jobs/webhook-delivery.job.ts`.

Merchants notice webhook problems before we do, so most of the time this page is opened because
a support ticket arrived, not because an alarm fired.

---

## 1. How a webhook gets delivered

```
bus event  →  WebhookFanoutConsumer          (the ONLY writer of webhook_event)
           →  WebhookEndpointsService.listEnabledFor(type)
           →  WebhookEventsService.fanout()   → one webhook_event row per endpoint
…every 15s…
              WebhookDeliveryJob.runOnce()    → claims pending rows past next_attempt_at
           →  HttpJsonDeliveryStrategy.deliver()   (or HttpForm for the four legacy endpoints)
           →  WebhookSecretService.decrypt() + .sign()
           →  BaseHttpClient.request()
```

`WebhookFanoutConsumer` is the only writer of `webhook_event`. If you find another one, that is
the bug.

## 2. State machine and retry schedule

```
pending ──▶ delivering ──┬──▶ delivered      (2xx)
                         ├──▶ pending        (retry — exponential backoff 1m·2^n, jitter ±20%)
                         └──▶ dead           (410 Gone, or attempts exhausted)
```

- Backoff is one minute doubling, with ±20% jitter. The jitter is not decoration: without it a
  merchant's outage produces a synchronised retry storm at every doubling boundary.
- **`410 Gone` skips the retry schedule entirely.** The merchant is telling us the endpoint will
  never accept again. Treating that as retryable is how you spend two days delivering to a URL
  somebody deleted on purpose.
- 72 hours with no success **plus** 20 consecutive dead events disables the endpoint. That is
  `WebhookEndpointsService.disableStale`, and it runs at the end of every delivery pass. Both
  conditions are required — a low-volume endpoint should not be disabled for being quiet.

---

## 3. "The merchant says they are not receiving webhooks"

Work it in this order. Each step rules out a whole class of cause.

1. **Is the endpoint enabled, and is the event type in `enabled_events`?**
   `GET /v1/webhook_endpoints`. An endpoint that was auto-disabled (§2) is the single most common
   answer and the merchant will not know it happened.

2. **Do `webhook_event` rows exist for their endpoint?**
   - No rows → the problem is upstream of delivery. Either the bus event never arrived
     (check `WebhookFanoutConsumer` and the DLQ) or the type is not in `enabled_events`.
   - Rows in `dead` → read `last_error`. It is stored per event and it is usually a TLS failure
     or a 4xx from their side.
   - Rows in `pending` with `next_attempt_at` in the past → the **job** is stuck. Go to §4.

3. **Redeliver.** `POST /v1/webhook_events/:id/redeliver`. Merchant admins and Payzeno support
   can both do it; support does it most. Redelivery resets attempts and signs freshly, so it is
   also the way to test after a merchant fixes their endpoint.

4. **Signature disputes.** If the merchant says the signature does not verify, the answer is
   almost always that they are verifying against a re-serialised body. The HMAC is over the raw
   bytes. A JSON round trip that reorders keys or changes whitespace produces a different
   signature and their library will not tell them that is what happened.

---

