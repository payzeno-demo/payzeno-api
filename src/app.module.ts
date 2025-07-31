/**
 * AppModule — the composition root, and the hottest file in the repo (blueprint §9.3).
 *
 * Three things live here and nothing else:
 *
 *   1. the feature-module list (one `IMPORTS` edge per module, blueprint §2);
 *   2. the TypeORM root connection, built from `ApiConfig` and never from `process.env`;
