/**
 * Capture. The hottest file on the money path — arc PCI took the PAN out of it, arc INC put
 * the `capture_at_settlement` branch in it, and arc MIG moved the fee posting out of it.
 *
 * Frame 4 of the repo's deepest chain:
 *   PaymentIntentsController.capture → PaymentIntentsService.capture → CapturePaymentFlow.execute
 *   → **ChargeCaptureService.captureCharge** → ProcessorRouter.select → WorldflowAdapter.capture
 *   → AcquirerHttpClient → BaseHttpClient.request → UndiciTransport.send
 *
 * and the persistence and event chains hang off this frame (blueprint §0).
 *
 * ### `capture_at_settlement` — read this before changing the branch below
 *
