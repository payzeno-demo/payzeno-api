/**
 * AppModule — the composition root, and the hottest file in the repo (blueprint §9.3).
 *
 * Three things live here and nothing else:
 *
 *   1. the feature-module list (one `IMPORTS` edge per module, blueprint §2);
 *   2. the TypeORM root connection, built from `ApiConfig` and never from `process.env`;
 *   3. the global request chain of api-surface.md §1.5, in that exact order.
 *
 * `ConfigModule` is not listed directly. It is instantiated once, inside `CommonModule`, and
 * re-exported from there. Two `ConfigModule.forRoot()` calls would mean two `ApiConfig`
 * objects and — worse — two ioredis clients, two SQS clients and two of every connection the
 * config module opens. One instance, reached through the module that everything imports.
 * docs/adr/0001-nestjs-module-boundaries.md §3.
