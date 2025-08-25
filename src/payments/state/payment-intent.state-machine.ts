/**
 * PaymentIntent FSM — domain-model.md §2.
 *
 * ```
 * requires_payment_method ──attach──▶ requires_confirmation ──confirm──▶ processing
 *         ▲                                                              │   ▲
 *         │ decline (retryable)                                          │   │ complete_action
 *         └──────────────────────────────────────────────────────────────┤   │
 *                                                     requires_action ◀───┴───┘
 *                                                                            ├─▶ requires_capture
 *                                                                            ├─▶ succeeded
 *                                                                            └─▶ failed
 * any non-terminal ──cancel──▶ canceled
 * ```
 *
 * `requires_action` is not optional: under PSD2 a EUR or GBP e-commerce authorisation without
