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

### Signing

Header is `Payzeno-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`. The HMAC is over `"{t}.{raw_body}"`
— the raw bytes, before any re-serialisation. Tolerance is five minutes.

Two `v1=` values appear during a secret rotation: the new secret first, the previous second.
That is what lets a merchant roll their verification without a delivery gap.

---

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

## 4. The delivery job is stuck

Symptom: `pending` rows with `next_attempt_at` in the past and no `job.finished` for
`webhook-delivery`.

- The job runs every 15s under a 60s `@JobLock`. If a pass overruns 60s, a second pass can start
  alongside it. Claims are `FOR UPDATE SKIP LOCKED`, so that is safe, but sustained overlap means
  the batch limit is too high or an endpoint is timing out at the transport limit every time.
- A single very slow merchant endpoint can consume a whole pass. Look for one `endpoint_id`
  dominating the pass duration.
- If the job is not running at all, check the Redis lease. A lease left behind by a killed task
  blocks starts until its TTL expires — that is 60s, so if it is longer than that, the job itself
  is down.

---

## 5. Secret rotation

`WebhookSecretService` holds the signing secret KMS-envelope-encrypted (migration 24):
`signing_secret_encrypted`, `signing_secret_previous_encrypted`, `signing_secret_last_four`,
`rotated_at`.

Rotation moves current → previous and mints a new current. Both are signed with until the
merchant confirms, which is why the header carries two `v1=` values.

**Known debt:** `readLegacySigningSecretHash()` is still there. It reads the pre-migration-24
`signing_secret_hash` column for endpoints that have not been rotated since. It was supposed to
survive one release. It is month 12 and it has survived twelve. It is harmless and it is on the
list.
