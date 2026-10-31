import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://pdl:pdl@localhost:5432/pdl_test', NODE_ENV: 'test', APP_SECRET: 'test-secret-123' },
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
