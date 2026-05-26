import { defineConfig } from 'vitest/config';

// Vitest picks up unit tests that live next to source as `*.test.ts`. The
// Playwright e2e suite under `tests/` uses `@playwright/test`'s own runner
// and globals; excluding it here keeps the two harnesses cleanly separate.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**', 'out/**'],
  },
});
