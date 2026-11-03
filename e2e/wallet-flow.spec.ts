import type { Page } from '@playwright/test';
import { test, expect, createWallet, waitForArkade, DAPP_URL, DAPP_PORT } from './fixtures.js';
import { startDappServer } from './dapp-server.js';

// Test-only globals stashed on the dApp page.
declare global {
  interface Window {
    arkade: {
      connect(): Promise<string[]>;
      getAddress(): Promise<string>;
      getBalance(): Promise<unknown>;
      getAccounts(): Promise<string[]>;
      isConnected(): Promise<boolean>;
      getProviderState(): Promise<{ isConnected: boolean; isUnlocked: boolean; network: string | null; accounts: string[] }>;
      sendToAddress(address: string, amount: number): Promise<string>;
      sendAsset(
        address: string,
        assets: Array<{ assetId: string; amount: number }>,
        bitcoinAmount?: number,
      ): Promise<string>;
      settle(): Promise<string>;
      signMessage(message: string): Promise<{ message: string; signature: string; address: string }>;
      on(event: string, cb: (data?: unknown) => void): void;
    };
    __accountsChangedEvents: unknown[];
    __connectResult: Promise<string[]>;
    __result: Promise<{ ok: boolean; value?: unknown; error?: string }>;
    __concurrentResults: Array<Promise<{ ok: boolean; value?: unknown; error?: string }>>;
    __lockEvents: number[];
  }
}

const FAKE_ASSET_ID = 'a'.repeat(64);

// Reject-path tail: wait for the popup, check it, reject, and confirm the
// dApp promise rejects. No funds needed: wallet calls only run on approval.
async function rejectApprovalAndExpectRejection(
  approvalPagePromise: Promise<Page>,
  dapp: Page,
  checkApproval: (approval: Page) => Promise<void>,
): Promise<void> {
  const approval = await approvalPagePromise;
  await approval.waitForLoadState('domcontentloaded');
  await checkApproval(approval);
  await approval.getByRole('button', { name: 'Reject' }).click();

  const result = await dapp.evaluate(() => window.__result);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/reject/i);
}

// Every approval-gated dApp request type, plus the background -> page event relay.
test.describe.serial('dApp connect / send / broadcast flow', () => {
  let popup: Page;
  let dapp: Page;
  let stopDappServer: () => Promise<void>;

  test.beforeAll(async ({ extensionContext, extensionId }) => {
    stopDappServer = await startDappServer(DAPP_PORT);

    popup = await extensionContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await createWallet(popup);
    // The lock button only renders once wallet_create resolved.
    await popup.waitForSelector('[title="Lock wallet"]', { timeout: 15_000 });

    dapp = await extensionContext.newPage();
    await dapp.goto(DAPP_URL);
    await waitForArkade(dapp);
  });

  test.afterAll(async () => {
    await stopDappServer();
  });

  // Must run before the connect test: this origin has to be unconnected.
  // A page must not reach privileged methods without connect().
  test('unconnected origin: privileged reads refuse or return empty, never real data', async () => {
    const addressResult = await dapp.evaluate(() =>
      window.arkade
        .getAddress()
        .then((v): { ok: boolean; value?: unknown; error?: string } => ({ ok: true, value: v }))
        .catch((e: Error) => ({ ok: false, error: e.message })),
    );
    expect(addressResult.ok).toBe(false);
    expect(addressResult.error).toMatch(/not connected/i);

    const balanceResult = await dapp.evaluate(() =>
      window.arkade
        .getBalance()
        .then((v): { ok: boolean; value?: unknown; error?: string } => ({ ok: true, value: v }))
        .catch((e: Error) => ({ ok: false, error: e.message })),
    );
    expect(balanceResult.ok).toBe(false);
    expect(balanceResult.error).toMatch(/not connected/i);

    const accounts = await dapp.evaluate(() => window.arkade.getAccounts());
    expect(accounts).toEqual([]);

    const isConnected = await dapp.evaluate(() => window.arkade.isConnected());
    expect(isConnected).toBe(false);

    const providerState = await dapp.evaluate(() => window.arkade.getProviderState());
    expect(providerState).toEqual({ isConnected: false, isUnlocked: false, network: null, accounts: [] });
  });

  test('connect: approval popup returns an address and fires accountsChanged', async ({ extensionContext }) => {
    await dapp.evaluate(() => {
      window.__accountsChangedEvents = [];
      window.arkade.on('accountsChanged', (d) => window.__accountsChangedEvents.push(d));
    });

    const approvalPagePromise = extensionContext.waitForEvent('page');
    // Not awaited: resolves only after the approval popup below.
    await dapp.evaluate(() => {
      window.__connectResult = window.arkade.connect();
    });

    const approval = await approvalPagePromise;
    await approval.waitForLoadState('domcontentloaded');
    await expect(approval.getByText('Connect to your wallet?')).toBeVisible({ timeout: 10_000 });
    await expect(approval.getByText(DAPP_URL)).toBeVisible();
    await approval.getByRole('button', { name: 'Approve' }).click();

    const result = await dapp.evaluate(() => window.__connectResult);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatch(/^ark1/);

    const events = await dapp.evaluate(() => window.__accountsChangedEvents);
    expect(events).toEqual([result]);
  });

  test('send: rejecting the approval popup surfaces as a rejected promise, not a hang', async ({ extensionContext }) => {
    const address = await dapp.evaluate(() => window.arkade.getAddress());

    const approvalPagePromise = extensionContext.waitForEvent('page');
    await dapp.evaluate((addr) => {
      window.__result = window.arkade
        .sendToAddress(addr, 1000)
        .then((txid) => ({ ok: true, value: txid }))
        .catch((e: Error) => ({ ok: false, error: e.message }));
    }, address);

    await rejectApprovalAndExpectRejection(approvalPagePromise, dapp, async (approval) => {
      await expect(approval.getByText('Approve transaction?')).toBeVisible({ timeout: 10_000 });
      await expect(approval.getByText('1,000 sats')).toBeVisible();
    });
  });

  test('sendAsset: approval popup shows the asset and amount, reject surfaces cleanly', async ({ extensionContext }) => {
    const address = await dapp.evaluate(() => window.arkade.getAddress());

    const approvalPagePromise = extensionContext.waitForEvent('page');
    await dapp.evaluate(
      ({ addr, assetId }) => {
        window.__result = window.arkade
          .sendAsset(addr, [{ assetId, amount: 500 }])
          .then((txid) => ({ ok: true, value: txid }))
          .catch((e: Error) => ({ ok: false, error: e.message }));
      },
      { addr: address, assetId: FAKE_ASSET_ID },
    );

    await rejectApprovalAndExpectRejection(approvalPagePromise, dapp, async (approval) => {
      await expect(approval.getByText('Send asset?')).toBeVisible({ timeout: 10_000 });
      await expect(approval.getByText('500')).toBeVisible();
    });
  });

  test('settle: approval popup describes the settlement, reject surfaces cleanly', async ({ extensionContext }) => {
    const approvalPagePromise = extensionContext.waitForEvent('page');
    await dapp.evaluate(() => {
      window.__result = window.arkade
        .settle()
        .then((txid) => ({ ok: true, value: txid }))
        .catch((e: Error) => ({ ok: false, error: e.message }));
    });

    await rejectApprovalAndExpectRejection(approvalPagePromise, dapp, async (approval) => {
      await expect(approval.getByText('Settle virtual outputs?')).toBeVisible({ timeout: 10_000 });
    });
  });

  test('signMessage: approval popup shows the full message, reject surfaces cleanly', async ({ extensionContext }) => {
    const approvalPagePromise = extensionContext.waitForEvent('page');
    await dapp.evaluate(() => {
      window.__result = window.arkade
        .signMessage('Sign in to example.com, nonce 42')
        .then((signed) => ({ ok: true, value: signed }))
        .catch((e: Error) => ({ ok: false, error: e.message }));
    });

    await rejectApprovalAndExpectRejection(approvalPagePromise, dapp, async (approval) => {
      await expect(approval.getByText('Sign this message?')).toBeVisible({ timeout: 10_000 });
      await expect(approval.getByText('Sign in to example.com, nonce 42')).toBeVisible();
      await expect(approval.getByText('Mainnet · Account 1')).toBeVisible();
    });
  });

  // Regression: the per-origin cap was counted after windows.create()
  // resolved, so concurrent calls all passed it.
  test('approval cap: at most 3 concurrent requests from one origin open a popup', async ({ extensionContext }) => {
    const address = await dapp.evaluate(() => window.arkade.getAddress());
    const popups: Page[] = [];
    const onPage = (p: Page) => {
      if (p.url().includes('approval.html')) popups.push(p);
    };
    extensionContext.on('page', onPage);

    await dapp.evaluate((addr) => {
      window.__concurrentResults = Array.from({ length: 5 }, (_, i) =>
        window.arkade
          .sendToAddress(addr, 1000 + i)
          .then((txid) => ({ ok: true, value: txid }))
          .catch((e: Error) => ({ ok: false, error: e.message })),
      );
    }, address);

    await expect.poll(() => popups.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    // Give any over-cap popup a moment to show up late.
    await dapp.waitForTimeout(500);
    extensionContext.off('page', onPage);
    expect(popups).toHaveLength(3);

    for (const p of popups) {
      await p.getByRole('button', { name: 'Reject' }).click();
    }

    const results = await dapp.evaluate(() => Promise.all(window.__concurrentResults));
    expect(results.every((r) => !r.ok)).toBe(true);
  });

  // Simulates a service-worker restart mid-approval: the request is in
  // storage.session but not in the in-memory pending map.
  test('approval persistence: a request known only to storage.session still executes on respond', async ({
    extensionContext,
  }) => {
    const sw = extensionContext.serviceWorkers()[0];
    const address = await dapp.evaluate(() => window.arkade.getAddress());
    const approvalId = 'e2e-simulated-restart-1';
    // Mirrors BackgroundRouter._activeWalletKey: the wallet the request was made on.
    const walletKey = await popup.evaluate(async () => {
      const settings = await chrome.runtime.sendMessage({ id: 'e2e-ns', method: 'wallet_getNetworkSettings' });
      const active = await chrome.runtime.sendMessage({ id: 'e2e-aa', method: 'wallet_getActiveAccount' });
      return `${settings.result.arkServerUrl}|${active.result.seedId}:${active.result.index}`;
    });

    await sw.evaluate(
      async ({ id, addr, key }) => {
        await chrome.storage.session.set({
          'arkade:pending-approval-requests': {
            [id]: { method: 'arkade_sendToAddress', params: { address: addr, amount: 1234 }, origin: 'http://localhost:8765', walletKey: key },
          },
        });
      },
      { id: approvalId, addr: address, key: walletKey },
    );

    // approval_respond is internal-only, so it must come from an extension page.
    const response = await popup.evaluate(
      ({ id }) =>
        chrome.runtime.sendMessage({
          id: 'e2e-probe',
          method: 'approval_respond',
          params: { approvalId: id, approved: true },
        }),
      { id: approvalId },
    );

    // With no funds, a recovered approval fails with a balance error - never
    // "expired", which is what a lost request looks like.
    expect(response.error).toBeDefined();
    expect(response.error).not.toMatch(/expired/i);
    expect(response.error).not.toMatch(/account or network changed/);
  });

  test('lock: background broadcast reaches the connected dApp page', async () => {
    await dapp.evaluate(() => {
      window.__lockEvents = [];
      window.arkade.on('lock', () => window.__lockEvents.push(Date.now()));
    });

    await popup.getByTitle('Lock wallet').click();

    await expect
      .poll(async () => dapp.evaluate(() => window.__lockEvents.length), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});
