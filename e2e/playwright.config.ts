import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Only pwa-popup.spec.ts uses this. A production build, not the dev server:
  // the dev server re-optimizes dependencies on first load and reloads the
  // page mid-test, and only the build carries the real CSP.
  webServer: {
    command: 'bun run build && bun run preview --port 4174 --strictPort',
    cwd: path.resolve(__dirname, '../apps/pwa'),
    port: 4174,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
