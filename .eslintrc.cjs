/* eslint-env node */

/**
 * payzeno-api lint config.
 *
 * The interesting half of this file is `boundaries`. This repo is eight layers deep on
 * purpose (see docs/adr/0001-nestjs-module-boundaries.md) and the only thing keeping a
 * controller from reaching straight into a TypeORM repository is the rule below.
 * Downward imports only. If you are here because CI told you "boundaries/element-types",
 * you imported upward — move the call into the layer that owns it.
 *
 * Element order matters: the first pattern that matches a file wins.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import', 'boundaries'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/typescript',
    'plugin:boundaries/recommended',
    'prettier',
  ],
  env: { node: true, jest: true },
  ignorePatterns: ['dist/**', 'coverage/**', 'node_modules/**', '*.js', '*.cjs'],
  settings: {
    'import/resolver': {
      typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
    },
    'boundaries/include': ['src/**/*.ts'],
    'boundaries/ignore': ['src/**/*.spec.ts', 'src/migrations/**'],
    'boundaries/elements': [
      { type: 'app', pattern: 'src/(main|app.module|instrumentation).ts', mode: 'full' },
      { type: 'module', pattern: 'src/**/*.module.ts', mode: 'full' },
      { type: 'controller', pattern: 'src/**/*.controller.ts', mode: 'full' },
      { type: 'gateway-ws', pattern: 'src/notifications/*.gateway.ts', mode: 'full' },
      { type: 'consumer', pattern: 'src/events/*.consumer.ts', mode: 'full' },
      { type: 'job', pattern: 'src/jobs/**', mode: 'folder' },
      { type: 'flow', pattern: 'src/**/flows/**', mode: 'folder' },
      { type: 'domain', pattern: 'src/**/state/**', mode: 'folder' },
      { type: 'domain', pattern: 'src/**/*.policy.ts', mode: 'full' },
      { type: 'domain', pattern: 'src/**/*.state-machine.ts', mode: 'full' },
      { type: 'gateway', pattern: 'src/payments/processor/processor.router.ts', mode: 'full' },
      { type: 'gateway', pattern: 'src/ledger/ledger-read-through.service.ts', mode: 'full' },
      { type: 'gateway', pattern: 'src/billing/invoice-source.resolver.ts', mode: 'full' },
      { type: 'adapter', pattern: 'src/payments/processor/**', mode: 'folder' },
      { type: 'adapter', pattern: 'src/payments/vault/**', mode: 'folder' },
      { type: 'adapter', pattern: 'src/webhooks/delivery/**', mode: 'folder' },
      { type: 'adapter', pattern: 'src/**/*-http.client.ts', mode: 'full' },
      { type: 'adapter', pattern: 'src/billing/billing-legacy.client.ts', mode: 'full' },
      { type: 'service', pattern: 'src/**/*.service.ts', mode: 'full' },
      { type: 'service', pattern: 'src/**/*.resolver.ts', mode: 'full' },
      { type: 'guard', pattern: 'src/auth/**', mode: 'folder' },
      { type: 'http-plumbing', pattern: 'src/common/(middleware|interceptors|filters)/**', mode: 'folder' },
      { type: 'transport', pattern: 'src/api/**', mode: 'folder' },
      { type: 'persistence', pattern: 'src/common/persistence/**', mode: 'folder' },
      { type: 'persistence', pattern: 'src/**/*.repository.ts', mode: 'full' },
      { type: 'entity', pattern: 'src/**/*.entity.ts', mode: 'full' },
      { type: 'dto', pattern: 'src/**/dto/**', mode: 'folder' },
      { type: 'config', pattern: 'src/config/**', mode: 'folder' },
      { type: 'primitive', pattern: 'src/common/**', mode: 'folder' },
    ],
  },
  rules: {
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'app', allow: ['*'] },
          { from: 'module', allow: ['*'] },
          {
            from: 'controller',
            allow: [
              'service',
              'gateway',
              'dto',
              'entity',
              'guard',
              'http-plumbing',
              'domain',
              'primitive',
              'config',
            ],
          },
          { from: 'gateway-ws', allow: ['service', 'guard', 'primitive', 'config', 'dto'] },
          {
            from: 'consumer',
            allow: ['service', 'gateway', 'persistence', 'entity', 'domain', 'primitive', 'config'],
          },
          {
            from: 'job',
            allow: [
              'service',
              'gateway',
              'adapter',
              'persistence',
              'entity',
              'domain',
              'primitive',
              'config',
            ],
          },
          {
            from: 'service',
            allow: [
              'flow',
              'gateway',
              'adapter',
              'domain',
              'persistence',
              'transport',
              'entity',
              'dto',
              'primitive',
              'config',
            ],
          },
          {
            from: 'flow',
            allow: ['gateway', 'adapter', 'domain', 'persistence', 'entity', 'primitive', 'config'],
          },
          // Policies and state machines are pure. No I/O, no persistence, no transport.
          { from: 'domain', allow: ['entity', 'primitive'] },
          {
            from: 'gateway',
            allow: ['adapter', 'transport', 'persistence', 'entity', 'primitive', 'config'],
          },
          { from: 'adapter', allow: ['transport', 'entity', 'primitive', 'config'] },
          { from: 'guard', allow: ['service', 'persistence', 'entity', 'primitive', 'config'] },
          { from: 'http-plumbing', allow: ['persistence', 'entity', 'primitive', 'config'] },
          { from: 'transport', allow: ['primitive', 'config'] },
          { from: 'persistence', allow: ['entity', 'primitive', 'config'] },
          { from: 'entity', allow: ['entity', 'primitive'] },
          { from: 'dto', allow: ['primitive', 'entity'] },
          { from: 'config', allow: ['primitive'] },
          { from: 'primitive', allow: ['primitive', 'config'] },
        ],
      },
    ],
    'boundaries/no-unknown-files': 'off',
    'boundaries/no-private': 'off',

    // process.env is read in exactly one file. Everything else takes ApiConfig.
    'no-restricted-properties': [
      'error',
      {
        object: 'process',
        property: 'env',
        message:
          'Read config through src/config/configuration.ts (ApiConfig). process.env is allowed there only.',
      },
    ],
    // HttpException is constructed in exactly one file: common/filters/http-exception.filter.ts.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@nestjs/common',
            importNames: ['HttpException', 'BadRequestException', 'NotFoundException'],
            message:
              'Throw the ApiException subclass from src/common/errors/. HttpExceptionFilter is the only translator.',
          },
        ],
      },
    ],

    '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/interface-name-prefix': 'off',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        pathGroups: [{ pattern: '@payzeno/**', group: 'external', position: 'after' }],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-cycle': ['error', { maxDepth: 4 }],
    'no-console': 'error',
    eqeqeq: ['error', 'smart'],
    curly: ['error', 'multi-line'],
  },
  overrides: [
    {
      files: ['src/config/configuration.ts'],
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      files: ['src/common/filters/http-exception.filter.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      files: ['src/migrations/*.ts'],
      rules: { '@typescript-eslint/no-explicit-any': 'off', 'import/order': 'off' },
    },
    {
      files: ['**/*.spec.ts', 'test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-properties': 'off',
        'boundaries/element-types': 'off',
      },
    },
  ],
};
