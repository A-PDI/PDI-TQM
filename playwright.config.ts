import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const STUB_PORT = Number(process.env.CARBONZAPP_STUB_PORT ?? 3199);
const VISUAL = /visual\.spec\.ts$/;
const VISUAL_FONTS = path.resolve(import.meta.dirname, 'tests/fixtures/fonts.conf');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', testIgnore: VISUAL, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testIgnore: VISUAL, use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    // Visual-regression baselines render with a pinned font set so they do not depend on the machine's fonts.
    {
      name: 'visual',
      testMatch: VISUAL,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { env: { ...process.env, FONTCONFIG_FILE: VISUAL_FONTS } } },
    },
  ],
  webServer: [
    {
      command: 'bash scripts/e2e-server.sh',
      url: `http://localhost:${PORT}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { E2E_PORT: String(PORT), CARBONZAPP_STUB_PORT: String(STUB_PORT) },
    },
    {
      // Local stand-in for the CarbonZapp cloud API (fictional fixture data).
      command: 'npx tsx scripts/carbonzapp-stub.ts',
      url: `http://127.0.0.1:${STUB_PORT}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { CARBONZAPP_STUB_PORT: String(STUB_PORT), CARBONZAPP_API_KEY: 'e2e-only-carbonzapp-key' },
    },
  ],
});
