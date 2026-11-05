import { defineConfig } from 'vitest/config';

// The store suite on Postgres. Every listed file also
// runs on SQLite under the default config; PG_TEST_URL names the server.
export default defineConfig({
  test: {
    include: [
      'src/main/db.ingestAnchor.test.ts',
      'src/main/db.planUsage.test.ts',
      'src/main/db.test.ts',
      'src/main/db.usageAnchors.test.ts',
      'src/main/dbEmbeddings.test.ts',
      'src/main/dbIngestBatch.test.ts',
      'src/main/dbReadCache.test.ts',
      'src/main/dbReadCharacterization.test.ts',
      'src/main/dbSessionCosts.test.ts',
      'src/main/dbSessionStats.test.ts',
      'src/main/dbSessionsList.test.ts',
      'src/main/dbSummaries.test.ts',
      'src/main/perfStore.test.ts',
      'src/main/store/pgMigrate.test.ts',
      'src/main/store/postgres.test.ts',
      'src/main/store/schemaParity.test.ts',
      'src/main/transcriptIndex.test.ts',
    ],
    env: { STORE_TEST_DIALECT: 'postgres' },
    globalSetup: ['src/main/store/pgGlobalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Keep maxWorkers × pools × PG_TEST_POOL_MAX well under max_connections (100).
    maxWorkers: 4,
  },
});
