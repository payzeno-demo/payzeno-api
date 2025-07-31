import type { Config } from 'jest';

// Unit + colocated spec config. E2E lives in jest.e2e.config.ts and is a separate
// CI step because it boots a real Nest app against Postgres.
const config: Config = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
  },
  moduleNameMapper: {
    '^@payzeno/contracts$': '<rootDir>/../payzeno-contracts/src/index.ts',
    '^@payzeno/contracts/(.*)$': '<rootDir>/../payzeno-contracts/src/$1',
    '^src/(.*)$': '<rootDir>/src/$1',
    '^test/(.*)$': '<rootDir>/test/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/test/support/jest.setup.ts'],
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/instrumentation.ts',
    '!src/**/*.module.ts',
    '!src/migrations/**',
    '!src/**/dto/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  // The 80% gate is real. PRs that drop below it do not merge. See CONTRIBUTING note
  // in README — reporting/ and merchants/users/ are the two directories dragging it down.
  coverageThreshold: {
    global: {
      lines: 80,
      statements: 80,
      branches: 70,
      functions: 78,
    },
    'src/payments/**/*.ts': { lines: 90 },
    'src/common/**/*.ts': { lines: 90 },
  },
  testTimeout: 10_000,
  maxWorkers: '60%',
};

export default config;
