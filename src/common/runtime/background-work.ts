/**
 * Whether this process runs the background work: the bus consumers' long-poll loops. (The crons
 * are the other half; a process that does not import `JobsModule` has none.)
 *
 * The API never binds this and runs everything. A one-shot script — `scripts/seed-demo.ts` —
 * binds `'disabled'` from a global module, so it can boot the real services without draining
 * queues that belong to the running API.
 */
export const BACKGROUND_WORK = Symbol('BACKGROUND_WORK');

export type BackgroundWork = 'enabled' | 'disabled';
