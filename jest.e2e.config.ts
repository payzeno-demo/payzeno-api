import type { Config } from 'jest';

import base from './jest.config';

// supertest against a booted app. The ledger is swapped for InMemoryLedgerClient and
// the outbound socket for InMemoryTransport (src/api/in-memory-transport.ts), so the
// only real infrastructure an e2e run needs is Postgres + Redis.
const config: Config = {
  ...base,
  roots: ['<rootDir>/test/e2e'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/test/support/e2e.global-setup.ts',
  globalTeardown: '<rootDir>/test/support/e2e.global-teardown.ts',
  collectCoverage: false,
  coverageThreshold: undefined,
  testTimeout: 60_000,
  maxWorkers: 1,
};

export default config;
