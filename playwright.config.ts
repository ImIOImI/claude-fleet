import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  // Retry transient flakes on CI (slow Windows runners occasionally miss the
  // modal-close timing window); keep local runs retry-free to surface flakes.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list'
});
