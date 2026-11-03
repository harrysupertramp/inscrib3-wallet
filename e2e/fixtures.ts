import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../apps/extension/.output/chrome-mv3');

export const WALLET_PASSWORD = 'e2e-test-password-1234';
export const DAPP_PORT = 8765;
export const DAPP_URL = `http://localhost:${DAPP_PORT}`;

// Worker-scoped fixtures go in test.extend()'s second type parameter.
type WorkerFixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
};

// MV3 extensions only load via a headed launchPersistentContext (CI uses xvfb).
// Worker-scoped so beforeAll and every serial test share this one context.
export const test = base.extend<{}, WorkerFixtures>({
  extensionContext: [
    async ({}, use) => {
      const context = await chromium.launchPersistentContext('', {
        headless: false,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
      });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      let [sw] = extensionContext.serviceWorkers();
      if (!sw) sw = await extensionContext.waitForEvent('serviceworker');
      await use(sw.url().split('/')[2]);
    },
    { scope: 'worker' },
  ],
});

// Stops after setup: the next screen differs between the extension and the PWA.
export async function createWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create new wallet' }).click();
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill(WALLET_PASSWORD);
  await passwordInputs.nth(1).fill(WALLET_PASSWORD);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  const nextButton = page.getByRole('button', { name: 'Next' });
  await nextButton.click();
  await nextButton.waitFor({ state: 'detached', timeout: 15_000 });
}

// Every PWA page has its own WalletManager, so it needs unlocking here too.
export async function unlockWallet(page: Page): Promise<void> {
  await page.locator('input[type="password"]').fill(WALLET_PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

export async function waitForArkade(page: Page): Promise<void> {
  await page.waitForFunction(() => 'arkade' in window, undefined, { timeout: 15_000 });
}

export { expect } from '@playwright/test';
