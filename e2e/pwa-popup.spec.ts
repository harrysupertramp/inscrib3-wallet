import { test, expect, type Page } from '@playwright/test';
import { startDappServer } from './dapp-server.js';
import { createWallet, unlockWallet } from './fixtures.js';

// Different port from the extension suite's dApp server, which may still be
// shutting down.
const DAPP_PORT = 8766;
const DAPP_URL = `http://localhost:${DAPP_PORT}`;
// Started by playwright.config.ts's webServer.
const PWA_URL = 'http://localhost:4174';

declare global {
  interface Window {
    __popupMessages: Array<Record<string, unknown>>;
  }
}

async function trackPopupMessages(dapp: Page): Promise<void> {
  await dapp.evaluate(() => {
    window.__popupMessages = [];
    window.addEventListener('message', (e) => window.__popupMessages.push(e.data as Record<string, unknown>));
  });
}

// What a dApp using the PWA fallback (no extension installed) does.
test.describe('PWA popup connect/send flow (no extension installed)', () => {
  let stopDappServer: () => Promise<void>;

  test.beforeAll(async () => {
    stopDappServer = await startDappServer(DAPP_PORT);
  });

  test.afterAll(async () => {
    await stopDappServer();
  });

  test('connect popup creates a wallet and posts the address back; a second popup unlocks and rejects a send request', async ({
    page,
    context,
  }) => {
    await page.goto(DAPP_URL);
    await trackPopupMessages(page);

    // --- connect, from a fresh wallet ---
    const connectUrl = `${PWA_URL}/?arkade_connect_origin=${encodeURIComponent(DAPP_URL)}`;
    const connectPopupPromise = context.waitForEvent('page');
    await page.evaluate((url) => window.open(url, 'connect-popup', 'width=380,height=640'), connectUrl);
    const connectPopup = await connectPopupPromise;
    await connectPopup.waitForLoadState('domcontentloaded');

    await createWallet(connectPopup);
    await expect(connectPopup.getByText('Connect to your wallet?')).toBeVisible({ timeout: 10_000 });
    await expect(connectPopup.getByText('Mainnet · Account 1')).toBeVisible();
    await connectPopup.getByRole('button', { name: 'Approve' }).click();

    await expect
      .poll(async () => page.evaluate(() => window.__popupMessages.length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const connectMessages = await page.evaluate(() => window.__popupMessages);
    expect(connectMessages).toHaveLength(1);
    expect(connectMessages[0].type).toBe('inscrib3:connect');
    const [address] = connectMessages[0].accounts as string[];
    expect(address).toMatch(/^ark1/);

    // --- send, rejected (no funds needed: wallet_send only runs on approval) ---
    const sendUrl =
      `${PWA_URL}/?arkade_send_origin=${encodeURIComponent(DAPP_URL)}` +
      `&arkade_send_address=${address}&arkade_send_amount=1000`;
    const sendPopupPromise = context.waitForEvent('page');
    await page.evaluate((url) => window.open(url, 'send-popup', 'width=380,height=640'), sendUrl);
    const sendPopup = await sendPopupPromise;
    await sendPopup.waitForLoadState('domcontentloaded');

    await unlockWallet(sendPopup);
    await expect(sendPopup.getByText('Approve transaction?')).toBeVisible({ timeout: 10_000 });
    await expect(sendPopup.getByText('1,000 sats')).toBeVisible();
    await sendPopup.getByRole('button', { name: 'Reject' }).click();

    await expect
      .poll(async () => page.evaluate(() => window.__popupMessages.length), { timeout: 10_000 })
      .toBeGreaterThan(1);
    const messages = await page.evaluate(() => window.__popupMessages);
    expect(messages[1].type).toBe('inscrib3:send_rejected');
  });
});
