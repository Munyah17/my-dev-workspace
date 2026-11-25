import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './smoke',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { executablePath: process.env.MONITOR_CHROMIUM || undefined },
  },
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:4173',
    env: { WORKSPACE_DEMO: '1', WORKSPACE_DATA_DIR: '.data/browser-smoke' },
  },
})
