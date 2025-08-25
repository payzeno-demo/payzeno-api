/**
 * ChargesService — read-heavy. The write path lives in `ChargeAuthorizationService` and
 * `ChargeCaptureService`; what is left here is the merchant-facing reads, the ledger
 * read-through, and one write that matters more than its size suggests.
 *
 * ### `markSettledFromBatch` — arc INC
 *
 * This is the sink for `settlement.completed` (`LedgerEventsConsumer`) and for
 * `POST /internal/v1/charges/:chargeId/settled` (the single-orphan out-of-band path). It runs
 * inside the consumer's transaction — the same transaction as the `processed_event` claim — so
 * a redelivered chunk cannot mark charges settled twice, and a rollback takes the settlement
 * marks with it.
 *
 * PAY-2058: a `settlement.completed` chunk lost to the DLQ strands charges `captured` forever,
 * which is why `UnsettledChargeSweepJob` exists and why `pix_charge_unsettled` finally has a
 * reader. Before that job, this method was the only writer of `settled` and nobody noticed the
 * gap for six weeks.
 */
