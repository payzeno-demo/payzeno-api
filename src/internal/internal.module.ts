/**
 * InternalModule — the service-to-service surface.
 *
 * It imports the feature modules it delegates to rather than reaching into their
 * repositories, so that a rule enforced in `MerchantsService` (say, that a suspended
 * merchant is still readable but never mutable) applies identically whether the caller is the
 * console or the ledger. Two code paths to the same table is how they drift.
