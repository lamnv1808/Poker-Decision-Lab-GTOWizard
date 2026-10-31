import { defineConfig, devices } from '@playwright/test';

const PORT = 8090;
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://pdl:pdl@localhost:5432/pdl_e2e_test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    // Reset the dedicated *_test DB, then start the server (which validates and seeds content).
    command: 'npx tsx ../web/e2e/reset-db.ts && npx tsx src/main.ts',
    cwd: '../server',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'test', APP_SECRET: 'e2e-secret-123', CORS_ORIGINS: '' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
});
