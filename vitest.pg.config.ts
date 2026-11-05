import { defineConfig } from 'vitest/config';

// The store suite on Postgres. Every listed file also
// runs on SQLite under the default config; PG_TEST_URL names the server.
export default defineConfig({
  test: {
    include: [
      'src/main/dbReadCharacterization.test.ts',
      'src/main/store/pgMigrate.test.ts',
      'src/main/store/postgres.test.ts',
      'src/main/store/schemaParity.test.ts',
    ],
    env: { STORE_TEST_DIALECT: 'postgres' },
    globalSetup: ['src/main/store/pgGlobalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
