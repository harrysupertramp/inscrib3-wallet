import { beforeEach, describe, expect, test } from 'bun:test';
import type { KeyValueStore } from '@inscrib3/core';
import { encodeBigints, decodeBigints } from './bigint-wire.js';

// A minimal fake of the WebExtension APIs the router touches. It must exist
// before the router module loads, which reads browser.runtime at import time.
type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
let messageListener: Listener;
let local: Map<string, unknown>;
let session: Map<string, unknown>;
let windowsOpened: string[];
let alarmsCreated: number;
let events: string[];

function area(map: () => Map<string, unknown>) {
  return {
    get: async (key: string) => ({ [key]: map().get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map().set(k, v);
    },
  };
}

(globalThis as unknown as { browser: unknown }).browser = {
  runtime: {
    getURL: (path: string) => `chrome-extension://ext${path}`,
    onMessage: { addListener: (fn: Listener) => (messageListener = fn) },
    sendMessage: async (m: { event?: string }) => void (m?.event && events.push(m.event)),
    getManifest: () => ({ version: '1.0.0' }),
  },
  storage: { local: area(() => local), session: area(() => session) },
  alarms: { create: () => alarmsCreated++, clear: async () => true, onAlarm: { addListener() {} } },
  tabs: { query: async () => [], sendMessage: async () => undefined },
  windows: {
    create: async ({ url }: { url: string }) => {
      windowsOpened.push(url);
      return { id: windowsOpened.length };
    },
    onRemoved: { addListener() {}, removeListener() {} },
  },
};

const { BackgroundRouter } = await import('./background-router.js');
const { isInternalSender, toRpcRequest } = await import('./protocol.js');

const DAPP = 'https://dapp.example';
const page = { origin: DAPP, url: `${DAPP}/app`, tab: { id: 1 } };
const internal = { origin: 'chrome-extension://ext', url: 'chrome-extension://ext/popup.html' };

const calls: string[] = [];
let activeAccount = { seedId: 0, index: 0 };
let unlocked = true;
let reconnectFails = false;
let sendArgs: unknown[] = [];
const manager = {
  onIncomingFunds: () => () => undefined,
  isUnlocked: () => unlocked,
  getAddress: async () => 'ark1address',
  getXOnlyPublicKey: async () => 'ab'.repeat(32),
  getBalance: async () => ({ total: 46_766n }),
  getTransactionHistory: async () => [{ txid: 'ark-tx', layer: 'ark' }],
  exportMnemonic: async () => (calls.push('exportMnemonic'), 'seed words'),
  send: async (...args: unknown[]) => {
    calls.push('send');
    sendArgs = args;
    return 'txid';
  },
  signMessage: async (message: string) => (calls.push('signMessage'), { message, signature: 'sig', address: 'bc1p' }),
  getActiveAccount: async () => activeAccount,
  listAccounts: async () => [{ seedId: 0, index: 0, label: 'Main' }],
  lock: async () => void calls.push('lock'),
  reconnect: async () => {
    calls.push('reconnect');
    if (reconnectFails) throw new Error('SERVER_UNREACHABLE: down');
  },
};

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => void map.set(key, value),
  };
}

let nextId = 0;
function send(method: string, params: unknown, sender: unknown): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    messageListener({ id: `t-${++nextId}`, method, params }, sender, resolve as (r: unknown) => void);
  });
}

async function waitForWindow(count: number): Promise<URL> {
  for (let i = 0; i < 100 && windowsOpened.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  return new URL(windowsOpened[count - 1]);
}

function connect(origin: string): void {
  local.set('arkade:permissions:origins', { [origin]: { connectedAt: 1 } });
}

beforeEach(() => {
  local = new Map();
  session = new Map();
  windowsOpened = [];
  alarmsCreated = 0;
  events = [];
  reconnectFails = false;
  calls.length = 0;
  activeAccount = { seedId: 0, index: 0 };
  unlocked = true;
  new BackgroundRouter(manager as never, memoryStore()).init();
});

describe('BackgroundRouter sender gating', () => {
  test('a web page cannot call internal wallet_* methods', async () => {
    connect(DAPP);
    const res = await send('wallet_exportMnemonic', { password: 'pw' }, page);
    expect(res.error).toMatch(/not available to web pages/);
    expect(calls).toEqual([]);
  });

  test('our own windows cannot call dApp methods', async () => {
    const res = await send('arkade_sendToAddress', { address: 'a', amount: 1 }, internal);
    expect(res.error).toMatch(/only available to web pages/);
  });

  test('an unknown method is rejected', async () => {
    expect((await send('wallet_doesNotExist', {}, internal)).error).toMatch(/Unknown method/);
  });
});

// Regression: a page could forge popup events (a fake "funds received") by
// sending an event-shaped object through content.ts.
describe('relayed page messages', () => {
  test('content.ts forwards only id, method and params', () => {
    const forged = { id: 'x', method: 'arkade_getBalance', params: [], _arkadeEvent: true, event: 'fundsReceived', data: { amountSats: 5_000_000 } };
    expect(toRpcRequest(forged)).toEqual({ id: 'x', method: 'arkade_getBalance', params: [] });
    expect(toRpcRequest({ _arkadeEvent: true, event: 'fundsReceived' })).toBeNull();
    expect(toRpcRequest('not an object')).toBeNull();
  });

  test('a message relayed from a page is not an internal sender; our own windows are', () => {
    expect(isInternalSender(page as never)).toBe(false);
    expect(isInternalSender(internal as never)).toBe(true);
  });
});

describe('BackgroundRouter unconnected origin', () => {
  test('reads refuse or return empty, and sends open no approval', async () => {
    expect((await send('arkade_getAddress', undefined, page)).error).toMatch(/Not connected/);
    expect((await send('arkade_getXOnlyPublicKey', undefined, page)).error).toMatch(/Not connected/);
    expect((await send('arkade_getAccounts', undefined, page)).result).toEqual([]);
    expect((await send('arkade_sendToAddress', { address: 'a', amount: 1 }, page)).error).toMatch(/Not connected/);
    expect(windowsOpened).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Regression: a connected dApp polling a read kept the wallet unlocked forever.
  test('no web page extends auto-lock, connected or not; the wallet\'s own windows do', async () => {
    await send('arkade_isConnected', undefined, page);
    connect(DAPP);
    await send('arkade_getAddress', undefined, page);
    expect(alarmsCreated).toBe(0);
    await send('wallet_isUnlocked', undefined, internal);
    expect(alarmsCreated).toBe(1);
  });
});

describe('BackgroundRouter approvals', () => {
  test('signMessage rejects an over-long message without opening a window', async () => {
    connect(DAPP);
    const res = await send('arkade_signMessage', { message: 'x'.repeat(1025) }, page);
    expect(res.error).toMatch(/at most 1024/);
    expect(windowsOpened).toEqual([]);
  });

  test('signMessage only signs after approval, and the popup names network and account', async () => {
    connect(DAPP);
    const pending = send('arkade_signMessage', { message: 'hello' }, page);
    const url = await waitForWindow(1);
    expect(url.searchParams.get('origin')).toBe(DAPP);
    expect(url.searchParams.get('network')).toBe('Mainnet');
    expect(url.searchParams.get('account')).toBe('Main');
    expect(calls).toEqual([]);

    await send('approval_respond', { approvalId: url.searchParams.get('id'), approved: true }, internal);
    expect((await pending).result).toMatchObject({ signature: 'sig' });
    expect(calls).toEqual(['signMessage']);
  });

  test('a rejected send never reaches the wallet', async () => {
    connect(DAPP);
    const pending = send('arkade_sendToAddress', { address: 'ark1dest', amount: 1000 }, page);
    const url = await waitForWindow(1);
    await send('approval_respond', { approvalId: url.searchParams.get('id'), approved: false }, internal);
    expect((await pending).error).toMatch(/rejected/);
    expect(calls).toEqual([]);
  });

  // Regression: the popup named one account, the send ran on whichever was
  // active when Approve was clicked.
  test('switching account while the popup is open cancels the approved send', async () => {
    connect(DAPP);
    const pending = send('arkade_sendToAddress', { address: 'ark1dest', amount: 1000 }, page);
    const url = await waitForWindow(1);
    activeAccount = { seedId: 0, index: 1 };
    await send('approval_respond', { approvalId: url.searchParams.get('id'), approved: true }, internal);
    expect((await pending).error).toMatch(/account or network changed/);
    expect(calls).toEqual([]);
  });

  test('an approval recovered after a restart is refused if the account changed', async () => {
    session.set('arkade:pending-approval-requests', {
      'recovered-1': { method: 'arkade_sendToAddress', params: { address: 'ark1dest', amount: 1000 }, origin: DAPP, walletKey: 'https://arkade.computer|0:0' },
    });
    activeAccount = { seedId: 1, index: 0 };
    const res = await send('approval_respond', { approvalId: 'recovered-1', approved: true }, internal);
    expect(res.error).toMatch(/account or network changed/);
    expect(calls).toEqual([]);
  });

  // Regression: approving a connect while locked errored, yet saved the
  // connection.
  test('while locked, a connect opens no popup and connects nothing', async () => {
    unlocked = false;
    const res = await send('arkade_connect', undefined, page);
    expect(res.error).toMatch(/Wallet is locked/);
    expect(windowsOpened).toEqual([]);
    expect(local.get('arkade:permissions:origins')).toBeUndefined();
  });

  test('a page cannot answer its own approval', async () => {
    connect(DAPP);
    void send('arkade_sendToAddress', { address: 'ark1dest', amount: 1000 }, page);
    const url = await waitForWindow(1);
    const res = await send('approval_respond', { approvalId: url.searchParams.get('id'), approved: true }, page);
    expect(res.error).toMatch(/not available to web pages/);
    expect(calls).toEqual([]);
  });
});

describe('BackgroundRouter network switch', () => {
  const settings = { arkServerUrl: 'https://mutinynet.arkade.sh', esploraUrl: 'https://mutinynet.com/api' };

  test('reconnects with the cached password instead of locking', async () => {
    const res = await send('wallet_setNetworkSettings', settings, internal);
    expect(res.result).toBe(true);
    expect(calls).toEqual(['reconnect']);
    expect(events).not.toContain('lock');
    expect(events).toContain('networkChanged');
  });

  test('locks and reports when the new server is unreachable', async () => {
    reconnectFails = true;
    const res = await send('wallet_setNetworkSettings', settings, internal);
    expect(res.error).toMatch(/couldn't be reached/);
    expect(events).toContain('lock');
  });
});

// Bigint values fail plain extension messaging with "Could not serialize message".
describe('BackgroundRouter bigint values', () => {
  test('a bigint result reaches the popup through JSON and decodes exactly', async () => {
    const res = await send('wallet_getBalance', undefined, internal);
    const wire = JSON.parse(JSON.stringify(res));
    expect(decodeBigints(wire.result)).toEqual({ total: 46_766n });
  });

  test('a bigint parameter from the popup arrives at the wallet as a bigint', async () => {
    const amount = 100_000_000_000_000_000_000n;
    const params = encodeBigints({ address: 'ark1address', amount });
    await send('wallet_send', JSON.parse(JSON.stringify(params)), internal);
    expect(sendArgs[1]).toBe(amount);
  });
});
