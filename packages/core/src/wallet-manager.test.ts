import { describe, expect, test, afterEach } from 'bun:test';
import { ArkAddress, SettlementEventType, TxType, type IWallet } from '@arkade-os/sdk';
import { WalletManager } from './wallet-manager.js';
import { encryptMnemonic, decryptMnemonic, saveEncryptedMnemonic, loadEncryptedMnemonic } from './session.js';
import { saveNetworkSettings } from './network-settings.js';
import { saveAccounts, saveActiveAccount } from './accounts.js';
import { inMemoryStore } from './test-helpers.js';

// _doInitWallet() needs a live Ark server, so tests inject a duck-typed fake
// wallet into the private fields instead.
function withWallet(manager: WalletManager, wallet: Partial<IWallet>, network = 'mutinynet'): void {
  (manager as unknown as { wallet: IWallet; network: string }).wallet = wallet as IWallet;
  (manager as unknown as { wallet: IWallet; network: string }).network = network;
}

// Stands in for a prior successful unlock, which is what caches the password.
function withPassword(manager: WalletManager, password: string): void {
  (manager as unknown as { password: string }).password = password;
}

function mockTx(overrides: { arkTxid?: string; type?: string; amount?: number; settled?: boolean; createdAt?: number }) {
  return {
    key: { arkTxid: overrides.arkTxid ?? 'tx1', commitmentTxid: '', boardingTxid: '' },
    type: overrides.type ?? TxType.TxReceived,
    amount: overrides.amount ?? 1000,
    settled: overrides.settled ?? true,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
  };
}

describe('WalletManager locked-state guards', () => {
  test('send() throws "Wallet is locked" before any wallet is set', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.send('ark1qaddr', 1000)).rejects.toThrow(/Wallet is locked/);
  });

  test('getBalance() throws "Wallet is locked" before any wallet is set', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.getBalance()).rejects.toThrow(/Wallet is locked/);
  });

  test('isUnlocked() reflects wallet presence', () => {
    const manager = new WalletManager(inMemoryStore());
    expect(manager.isUnlocked()).toBe(false);
    withWallet(manager, {});
    expect(manager.isUnlocked()).toBe(true);
  });
});

describe('WalletManager.send', () => {
  test('rejects an invalid address without calling wallet.send', async () => {
    const manager = new WalletManager(inMemoryStore());
    let called = false;
    withWallet(manager, { send: async () => ((called = true), 'txid') });
    await expect(manager.send('', 1000)).rejects.toThrow(/Invalid address/);
    expect(called).toBe(false);
  });

  test('rejects an invalid amount without calling wallet.send', async () => {
    const manager = new WalletManager(inMemoryStore());
    let called = false;
    withWallet(manager, { send: async () => ((called = true), 'txid') });
    await expect(manager.send('ark1qaddr', 0)).rejects.toThrow(/Invalid amount/);
    expect(called).toBe(false);
  });

  test('delegates to wallet.send with the given address/amount', async () => {
    const manager = new WalletManager(inMemoryStore());
    let received: unknown;
    withWallet(manager, {
      send: async (params) => {
        received = params;
        return 'txid-1';
      },
    });
    const txid = await manager.send('ark1qaddr', 5000);
    expect(txid).toBe('txid-1');
    expect(received).toEqual({ recipients: [{ address: 'ark1qaddr', amount: 5000 }] });
  });

  test('resolves selectedVtxos against a fresh getSpendableVtxos() call and threads them through', async () => {
    const manager = new WalletManager(inMemoryStore());
    let received: unknown;
    withWallet(manager, {
      getSpendableVtxos: async () =>
        [
          { txid: 'tx1', vout: 0, value: 1000, isPreconfirmed: true, createdAt: new Date(0) },
          { txid: 'tx2', vout: 1, value: 2000, isPreconfirmed: true, createdAt: new Date(0) },
        ] as never,
      send: async (params) => {
        received = params;
        return 'txid-2';
      },
    });
    await manager.send('ark1qaddr', 1000, [{ txid: 'tx1', vout: 0 }]);
    expect(received).toEqual({
      recipients: [{ address: 'ark1qaddr', amount: 1000 }],
      selectedVtxos: [{ txid: 'tx1', vout: 0, value: 1000, isPreconfirmed: true, createdAt: new Date(0) }],
    });
  });

  test('rejects a selection that is no longer spendable, without calling wallet.send', async () => {
    const manager = new WalletManager(inMemoryStore());
    let called = false;
    withWallet(manager, {
      getSpendableVtxos: async () => [] as never,
      send: async () => ((called = true), 'txid'),
    });
    await expect(manager.send('ark1qaddr', 1000, [{ txid: 'tx1', vout: 0 }])).rejects.toThrow(
      /SELECTED_VTXOS_NO_LONGER_SPENDABLE/,
    );
    expect(called).toBe(false);
  });
});

describe('WalletManager.sendAsset', () => {
  test('rejects an empty assets array', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {});
    await expect(manager.sendAsset('ark1qaddr', [])).rejects.toThrow(/At least one asset/);
  });

  test('rejects an invalid assetId inside the list', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {});
    await expect(manager.sendAsset('ark1qaddr', [{ assetId: '', amount: 10 }])).rejects.toThrow(/Invalid assetId/);
  });

  test('rejects an invalid bitcoinAmount when provided', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {});
    await expect(manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 10 }], -1)).rejects.toThrow(/Invalid bitcoinAmount/);
  });

  test('converts asset amounts to BigInt and omits bitcoinAmount when not given', async () => {
    const manager = new WalletManager(inMemoryStore());
    let received: unknown;
    withWallet(manager, {
      send: async (params) => {
        received = params;
        return 'txid-asset';
      },
    });
    await manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 250 }]);
    expect(received).toEqual({
      recipients: [{ address: 'ark1qaddr', assets: [{ assetId: 'a1', amount: 250n }] }],
    });
  });

  describe('an asset held by an unfinished settlement (O-12)', () => {
    const held = { txid: 'c'.repeat(64), vout: 0 };
    function withIntent(manager: WalletManager, updatedAt: number, deleted: unknown[]): void {
      const intents = new Map([['i1', {
        intentTxId: 'i1',
        state: 'waiting_for_batch',
        createdAt: updatedAt,
        updatedAt,
        registerProof: 'r',
        registerProofMessage: '{}',
        deleteProof: 'p',
        deleteProofMessage: '{}',
        partialForfeits: [],
        intentVtxos: [held],
      }]]);
      const fields = manager as unknown as { intentRepository: unknown; arkProvider: unknown };
      fields.intentRepository = {
        getIntentsPage: async () => ({ items: [...intents.values()] }),
        saveIntent: async (i: { intentTxId: string }) => void intents.set(i.intentTxId, i as never),
      };
      fields.arkProvider = { deleteIntent: async (i: unknown) => void deleted.push(i) };
    }
    function walletHoldingAsset(sent: unknown[]): Partial<IWallet> {
      return {
        getSpendableVtxos: async () => [] as never,
        getVtxos: async () => [{ ...held, value: 330, assets: [{ assetId: 'a1', amount: 250n }] }] as never,
        send: async (params) => {
          sent.push(params);
          return 'txid-asset';
        },
      };
    }

    test('is refused, saying when it frees up, while the settlement is still live', async () => {
      const manager = new WalletManager(inMemoryStore());
      const sent: unknown[] = [];
      const deleted: unknown[] = [];
      withWallet(manager, walletHoldingAsset(sent));
      withIntent(manager, Date.now(), deleted);
      await expect(manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 250 }])).rejects.toThrow(
        /250 units of this asset are held by a settlement that hasn't finished, so only 0 can be spent now/,
      );
      expect(sent).toEqual([]);
      expect(deleted).toEqual([]);
    });

    test('is freed when the settlement has stalled for 15 minutes, and the send goes ahead', async () => {
      const manager = new WalletManager(inMemoryStore());
      const sent: unknown[] = [];
      const deleted: unknown[] = [];
      withWallet(manager, walletHoldingAsset(sent));
      withIntent(manager, Date.now() - 16 * 60_000, deleted);
      await manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 250 }]);
      expect(deleted).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });
  });

  test('includes bitcoinAmount when explicitly given', async () => {
    const manager = new WalletManager(inMemoryStore());
    let received: unknown;
    withWallet(manager, {
      send: async (params) => {
        received = params;
        return 'txid-asset';
      },
    });
    await manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 250 }], 1000);
    expect(received).toEqual({
      recipients: [{ address: 'ark1qaddr', assets: [{ assetId: 'a1', amount: 250n }], amount: 1000 }],
    });
  });

  test('threads selectedVtxos through, resolved against getSpendableVtxos()', async () => {
    const manager = new WalletManager(inMemoryStore());
    let received: unknown;
    withWallet(manager, {
      getSpendableVtxos: async () =>
        [{ txid: 'tx1', vout: 0, value: 1000, isPreconfirmed: true, createdAt: new Date(0) }] as never,
      send: async (params) => {
        received = params;
        return 'txid-asset';
      },
    });
    await manager.sendAsset('ark1qaddr', [{ assetId: 'a1', amount: 250 }], undefined, [{ txid: 'tx1', vout: 0 }]);
    expect(received).toEqual({
      recipients: [{ address: 'ark1qaddr', assets: [{ assetId: 'a1', amount: 250n }] }],
      selectedVtxos: [{ txid: 'tx1', vout: 0, value: 1000, isPreconfirmed: true, createdAt: new Date(0) }],
    });
  });
});

describe('WalletManager.settle', () => {
  test('returns the txid on success', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, { settle: async () => 'settle-txid' });
    expect(await manager.settle()).toBe('settle-txid');
  });

  test('rewrites a minExpiryGap failure into BLOCKED_BY_EXPIRING_VTXO', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      settle: async () => {
        throw new Error('server rejected: minExpiryGap violated');
      },
    });
    await expect(manager.settle()).rejects.toThrow(/BLOCKED_BY_EXPIRING_VTXO/);
  });

  test('rewrites an INVALID_PSBT_INPUT failure into BLOCKED_BY_EXPIRING_VTXO', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      settle: async () => {
        throw new Error('INVALID_PSBT_INPUT: bad input');
      },
    });
    await expect(manager.settle()).rejects.toThrow(/BLOCKED_BY_EXPIRING_VTXO/);
  });

  test('rethrows an unrelated failure unchanged', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      settle: async () => {
        throw new Error('server unreachable');
      },
    });
    await expect(manager.settle()).rejects.toThrow('server unreachable');
  });
});

describe('WalletManager settlement progress', () => {
  test('isSettling() is false before/after and buffers events raised via the eventCallback', async () => {
    const manager = new WalletManager(inMemoryStore());
    const fakeEvents = [{ type: 'batch_started' }, { type: 'batch_finalized' }] as never[];
    withWallet(manager, {
      settle: async (_params, eventCallback) => {
        expect(manager.isSettling()).toBe(true);
        for (const e of fakeEvents) eventCallback?.(e);
        return 'settle-txid';
      },
    });
    expect(manager.isSettling()).toBe(false);
    const txid = await manager.settle();
    expect(txid).toBe('settle-txid');
    expect(manager.isSettling()).toBe(false);
    expect(await manager.getSettleProgress()).toEqual({ events: fakeEvents, done: true, txid: 'settle-txid' });
  });

  // Regression: raw SDK events (batchExpiry is a bigint) broke extension
  // messaging, so the settle log never updated in the extension.
  test('progress keeps only type and failure reason, so it survives extension messaging', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      settle: async (_params, eventCallback) => {
        eventCallback?.({ type: SettlementEventType.BatchStarted, id: 'b', intentIdHashes: [], batchExpiry: 1n } as never);
        eventCallback?.({ type: SettlementEventType.BatchFailed, id: 'b', reason: 'timeout' } as never);
        return 'settle-txid';
      },
    });
    await manager.settle();
    const progress = await manager.getSettleProgress();
    expect(() => JSON.stringify(progress)).not.toThrow();
    expect(progress.events).toEqual([
      { type: SettlementEventType.BatchStarted },
      { type: SettlementEventType.BatchFailed, reason: 'timeout' },
    ]);
  });

  test('getSettleProgress() records the error on a failed settlement', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      settle: async () => {
        throw new Error('server unreachable');
      },
    });
    await expect(manager.settle()).rejects.toThrow();
    const progress = await manager.getSettleProgress();
    expect(progress.done).toBe(true);
    expect(progress.error).toContain('server unreachable');
  });

  test('getSettleProgress() before any settle() returns an empty, done state', async () => {
    const manager = new WalletManager(inMemoryStore());
    expect(await manager.getSettleProgress()).toEqual({ events: [], done: true });
  });

  test('rejects a concurrent settle() call while one is already in progress', async () => {
    const manager = new WalletManager(inMemoryStore());
    let resolveFirst: (txid: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    withWallet(manager, { settle: () => pending });

    const first = manager.settle(); // starts, sets `settling = true` synchronously, awaits `pending`
    await expect(manager.settle()).rejects.toThrow(/already in progress/);
    resolveFirst('settle-txid');
    expect(await first).toBe('settle-txid');
  });
});

describe('WalletManager.getVtxos', () => {
  test('maps isPreconfirmed to status and converts dates to unix seconds', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      getVtxos: async () =>
        [
          {
            txid: 'tx1',
            vout: 0,
            value: 1000,
            isPreconfirmed: true,
            createdAt: new Date(1_700_000_000_000),
            expiresAt: new Date(1_700_100_000_000),
            assets: [{ assetId: 'a1' }],
          },
          {
            txid: 'tx2',
            vout: 1,
            value: 2000,
            isPreconfirmed: false,
            isSwept: true,
            createdAt: new Date(1_700_000_000_000),
            expiresAt: undefined,
            assets: undefined,
          },
        ] as never,
    });
    const vtxos = await manager.getVtxos();
    expect(vtxos[0]).toEqual({
      txid: 'tx1',
      vout: 0,
      value: 1000,
      status: 'preconfirmed',
      createdAt: 1_700_000_000,
      expiresAt: 1_700_100_000,
      swept: false,
      assetIds: ['a1'],
    });
    expect(vtxos[1]).toEqual({
      txid: 'tx2',
      vout: 1,
      value: 2000,
      status: 'settled',
      createdAt: 1_700_000_000,
      expiresAt: undefined,
      swept: true,
      assetIds: [],
    });
  });
});

describe('WalletManager.getSpendableVtxos', () => {
  test('reads from wallet.getSpendableVtxos(), not getVtxos(), and maps the same shape', async () => {
    const manager = new WalletManager(inMemoryStore());
    let getVtxosCalled = false;
    withWallet(manager, {
      getVtxos: async () => {
        getVtxosCalled = true;
        return [] as never;
      },
      getSpendableVtxos: async () =>
        [
          {
            txid: 'tx1',
            vout: 0,
            value: 1000,
            isPreconfirmed: true,
            createdAt: new Date(1_700_000_000_000),
          },
        ] as never,
    });
    const vtxos = await manager.getSpendableVtxos();
    expect(getVtxosCalled).toBe(false);
    expect(vtxos).toEqual([
      {
        txid: 'tx1',
        vout: 0,
        value: 1000,
        status: 'preconfirmed',
        createdAt: 1_700_000_000,
        expiresAt: undefined,
        swept: false,
        assetIds: [],
      },
    ]);
  });
});

describe('WalletManager.getBalance', () => {
  test('converts asset amounts from bigint to number', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      getBalance: async () =>
        ({
          boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
          settled: 1000,
          preconfirmed: 0,
          available: 1000,
          recoverable: 0,
          total: 1000,
          assets: [{ assetId: 'a1', amount: 12345n }],
        }) as never,
    });
    const balance = await manager.getBalance();
    expect(balance.assets).toEqual([{ assetId: 'a1', amount: 12345 }]);
    expect(balance.settled).toBe(1000);
  });
});

describe('WalletManager.exportMnemonic', () => {
  test('throws "No wallet found" when nothing has been saved', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.exportMnemonic('pw')).rejects.toThrow(/No wallet found/);
  });

  test('round-trips the mnemonic with the correct password, independent of lock state', async () => {
    const store = inMemoryStore();
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await saveEncryptedMnemonic(store, await encryptMnemonic(mnemonic, 'correct-password'));
    const manager = new WalletManager(store);
    expect(manager.isUnlocked()).toBe(false);
    expect(await manager.exportMnemonic('correct-password')).toBe(mnemonic);
  });

  test('rejects the wrong password', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic('some mnemonic words', 'right-password'));
    const manager = new WalletManager(store);
    await expect(manager.exportMnemonic('wrong-password')).rejects.toThrow();
  });
});

describe('WalletManager accounts', () => {
  test('listAccounts defaults to a single "Account 1" at seed 0 / index 0', async () => {
    const manager = new WalletManager(inMemoryStore());
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
  });

  test('getActiveAccount defaults to seed 0 / index 0', async () => {
    const manager = new WalletManager(inMemoryStore());
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
  });

  test('renameAccount updates the label', async () => {
    const manager = new WalletManager(inMemoryStore());
    await manager.renameAccount(0, 0, 'Savings');
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Savings' }]);
  });

  test('renameAccount trims whitespace and rejects an empty label', async () => {
    const manager = new WalletManager(inMemoryStore());
    await manager.renameAccount(0, 0, '  Trading  ');
    expect((await manager.listAccounts())[0].label).toBe('Trading');
    await expect(manager.renameAccount(0, 0, '   ')).rejects.toThrow(/must not be empty/);
  });

  test('renameAccount throws for a (seedId, index) that does not exist', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.renameAccount(0, 1, 'Ghost')).rejects.toThrow(/No such account/);
    await expect(manager.renameAccount(1, 0, 'Ghost')).rejects.toThrow(/No such account/);
  });

  // "locked" here means no password was ever cached.
  test('addAccount throws "Wallet is locked" with no cached password, without adding an account', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.addAccount()).rejects.toThrow(/Wallet is locked/);
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
  });

  test('importSeed throws "Wallet is locked" with no cached password, without importing a seed', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.importSeed('some mnemonic words')).rejects.toThrow(/Wallet is locked/);
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
  });

  test('switchAccount throws "Wallet is locked" with no cached password, without changing the active account', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.switchAccount(0, 0)).rejects.toThrow(/Wallet is locked/);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
  });

  test('switchAccount rejects a nonexistent (seedId, index) before decrypting anything', async () => {
    const store = inMemoryStore();
    const manager = new WalletManager(store);
    withPassword(manager, 'irrelevant-password');
    await expect(manager.switchAccount(0, 5)).rejects.toThrow(/No such account/);
    await expect(manager.switchAccount(5, 0)).rejects.toThrow(/No such account/);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
  });

  // From here these methods reach _initWallet()'s network call. An .invalid
  // server fails it deterministically; the seeds involved must be stored.
  const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  test('addAccount persists the next account index and label before the network call, even if that call then fails', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await expect(manager.addAccount('Savings')).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(await manager.listAccounts()).toEqual([
      { seedId: 0, index: 0, label: 'Account 1' },
      { seedId: 0, index: 1, label: 'Savings' },
    ]);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 1 });
  });

  test('switchAccount persists the new active account before the network call, even if that call then fails', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await store.set('arkade:accounts:list', [
      { seedId: 0, index: 0, label: 'Main' },
      { seedId: 0, index: 1, label: 'Savings' },
    ]);
    await expect(manager.switchAccount(0, 1)).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 1 });
  });

  test('importSeed persists a new seed under the next seedId, encrypted with the same shared password, before the network call', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    const secondMnemonic = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    await expect(manager.importSeed(secondMnemonic, 'Second wallet')).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(await manager.listAccounts()).toEqual([
      { seedId: 0, index: 0, label: 'Account 1' },
      { seedId: 1, index: 0, label: 'Second wallet' },
    ]);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 1, index: 0 });
    // The new seed must decrypt with the same shared password.
    const stored = await loadEncryptedMnemonic(store, 1);
    expect(stored).not.toBeNull();
    expect(await decryptMnemonic(stored!, 'shared-password')).toBe(secondMnemonic);
  });

  // Regression: the id came from the visible list only, so importing after a
  // removed (hidden) seed overwrote that seed's stored copy.
  test('importSeed never reuses the id of a removed seed, whose encrypted copy stays stored', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    const hiddenSeed = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    await saveEncryptedMnemonic(store, await encryptMnemonic(hiddenSeed, 'shared-password'), 1);
    await store.set('arkade:accounts:list', [{ seedId: 0, index: 0, label: 'Account 1' }]);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await expect(
      manager.importSeed('legal winner thank year wave sausage worth useful legal winner thank yellow', 'Imported'),
    ).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect((await manager.listAccounts()).find((a) => a.label === 'Imported')?.seedId).toBe(2);
    expect(await decryptMnemonic((await loadEncryptedMnemonic(store, 1))!, 'shared-password')).toBe(hiddenSeed);
  });

  // Regression: accounts stored before multi-seed support have no seedId, and
  // Math.max(0, undefined) is NaN.
  test('importSeed computes seedId 1, not NaN, when existing accounts predate the seedId field', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    await store.set('arkade:accounts:list', [
      { index: 0, label: 'Main' },
      { index: 1, label: 'Second' },
    ]);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await expect(
      manager.importSeed('legal winner thank year wave sausage worth useful legal winner thank yellow', 'Imported'),
    ).rejects.toThrow(/SERVER_UNREACHABLE/);
    const accounts = await manager.listAccounts();
    expect(accounts.find((a) => a.label === 'Imported')?.seedId).toBe(1);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 1, index: 0 });
  });

  // Same legacy data in addAccount(): without the guard the new account would
  // reuse index 0.
  test('addAccount computes the next index correctly even when existing accounts on the same seed predate the seedId field', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'shared-password'), 0);
    await store.set('arkade:accounts:list', [
      { index: 0, label: 'Main' },
      { index: 1, label: 'Second' },
    ]);
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await expect(manager.addAccount('Third')).rejects.toThrow(/SERVER_UNREACHABLE/);
    const accounts = await manager.listAccounts();
    expect(accounts.find((a) => a.label === 'Third')).toEqual({ seedId: 0, index: 2, label: 'Third' });
  });

  // restore() shares create(): a new seed must not inherit old accounts.
  test('create() resets the accounts list and active account back to defaults', async () => {
    const store = inMemoryStore();
    await store.set('arkade:accounts:list', [
      { seedId: 0, index: 0, label: 'Old Main' },
      { seedId: 1, index: 0, label: 'Old Imported' },
    ]);
    await store.set('arkade:accounts:active', { seedId: 1, index: 0 });
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    // create() doesn't wrap init failures in SERVER_UNREACHABLE.
    await expect(manager.create(TEST_MNEMONIC, 'new-password')).rejects.toThrow();
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
    expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
  });

  // Regression: an invalid phrase used to be stored before validation, leaving
  // a wallet that could never unlock and no way back to setup.
  test('create() refuses to overwrite an existing wallet', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'original'));
    const before = await loadEncryptedMnemonic(store, 0);
    const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await expect(new WalletManager(store).create(other, 'new-password')).rejects.toThrow(/already exists/);
    expect(await loadEncryptedMnemonic(store, 0)).toEqual(before);
  });

  test('create() rejects an invalid seed phrase without storing anything', async () => {
    const store = inMemoryStore();
    const manager = new WalletManager(store);
    const typo = TEST_MNEMONIC.replace('about', 'abort');
    await expect(manager.create(typo, 'password')).rejects.toThrow(/Invalid seed phrase/);
    expect(await manager.isCreated()).toBe(false);
  });

  test('importSeed rejects an invalid seed phrase without adding an account', async () => {
    const store = inMemoryStore();
    const manager = new WalletManager(store);
    withPassword(manager, 'shared-password');
    await expect(manager.importSeed('not a real seed phrase')).rejects.toThrow(/Invalid seed phrase/);
    expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
    expect(await loadEncryptedMnemonic(store, 1)).toBeNull();
  });

  test('create() normalizes pasted whitespace and case before storing', async () => {
    const store = inMemoryStore();
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    const messy = `  ${TEST_MNEMONIC.toUpperCase().split(' ').join('\n  ')}  `;
    await expect(manager.create(messy, 'password')).rejects.toThrow();
    expect(await decryptMnemonic((await loadEncryptedMnemonic(store, 0))!, 'password')).toBe(TEST_MNEMONIC);
  });

  describe('removeAccount', () => {
    test('removes a non-active account from the list', async () => {
      const store = inMemoryStore();
      await saveAccounts(store, [
        { seedId: 0, index: 0, label: 'Main' },
        { seedId: 0, index: 1, label: 'Side account' },
      ]);
      const manager = new WalletManager(store);
      await manager.removeAccount(0, 1);
      expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Main' }]);
    });

    test('throws for a (seedId, index) that does not exist', async () => {
      const manager = new WalletManager(inMemoryStore());
      await expect(manager.removeAccount(0, 5)).rejects.toThrow(/No such account/);
    });

    test('refuses to remove the only remaining account', async () => {
      const manager = new WalletManager(inMemoryStore());
      await expect(manager.removeAccount(0, 0)).rejects.toThrow(/only account/);
      expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
    });

    test('refuses to remove the currently active account, even when another account exists', async () => {
      const store = inMemoryStore();
      await saveAccounts(store, [
        { seedId: 0, index: 0, label: 'Main' },
        { seedId: 0, index: 1, label: 'Side account' },
      ]);
      await saveActiveAccount(store, { seedId: 0, index: 0 });
      const manager = new WalletManager(store);
      await expect(manager.removeAccount(0, 0)).rejects.toThrow(/active account/);
      expect(await manager.listAccounts()).toEqual([
        { seedId: 0, index: 0, label: 'Main' },
        { seedId: 0, index: 1, label: 'Side account' },
      ]);
    });

    test('removing an account never touches its stored seed ciphertext', async () => {
      const store = inMemoryStore();
      await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'pw'), 1);
      await saveAccounts(store, [
        { seedId: 0, index: 0, label: 'Main' },
        { seedId: 1, index: 0, label: 'Imported' },
      ]);
      const manager = new WalletManager(store);
      await manager.removeAccount(1, 0);
      expect(await manager.listAccounts()).toEqual([{ seedId: 0, index: 0, label: 'Main' }]);
      expect(await loadEncryptedMnemonic(store, 1)).not.toBeNull();
    });
  });

  describe('recovery from a bad active-account pointer', () => {
    test('resetToPrimaryAccount resets the active account to seed 0 / index 0, no password needed', async () => {
      const store = inMemoryStore();
      await store.set('arkade:accounts:active', { seedId: 3, index: 7 });
      const manager = new WalletManager(store);
      await manager.resetToPrimaryAccount();
      expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
    });

    // A stale pointer would otherwise block unlock forever.
    test('unlock() falls back to seed 0 / account 0 when the recorded active account does not exist in the accounts list', async () => {
      const store = inMemoryStore();
      await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'right-password'), 0);
      await store.set('arkade:accounts:active', { seedId: 0, index: 9 });
      await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
      const manager = new WalletManager(store);
      await expect(manager.unlock('right-password')).rejects.toThrow(/SERVER_UNREACHABLE/);
      // The corrected pointer is persisted.
      expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 0 });
    });

    test('unlock() does NOT override a valid active account, even one that then fails to initialize', async () => {
      const store = inMemoryStore();
      await saveEncryptedMnemonic(store, await encryptMnemonic(TEST_MNEMONIC, 'right-password'), 0);
      await saveAccounts(store, [
        { seedId: 0, index: 0, label: 'Main' },
        { seedId: 0, index: 1, label: 'Side account' },
      ]);
      await saveActiveAccount(store, { seedId: 0, index: 1 });
      await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
      const manager = new WalletManager(store);
      await expect(manager.unlock('right-password')).rejects.toThrow(/SERVER_UNREACHABLE/);
      expect(await manager.getActiveAccount()).toEqual({ seedId: 0, index: 1 });
    });
  });
});

// Re-init needs a live server, so only the guards before it are tested here.
describe('WalletManager.resetLocalCache', () => {
  test('throws "Wallet is locked" before any wallet is set', async () => {
    const manager = new WalletManager(inMemoryStore());
    await expect(manager.resetLocalCache('pw')).rejects.toThrow(/Wallet is locked/);
  });

  test('throws "No wallet found" when unlocked but nothing was ever saved', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {});
    await expect(manager.resetLocalCache('pw')).rejects.toThrow(/No wallet found/);
  });

  test('rejects the wrong password without ever calling wallet.clear()', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic('some mnemonic words', 'right-password'));
    const manager = new WalletManager(store);
    let clearCalled = false;
    withWallet(manager, { clear: async () => { clearCalled = true; } });
    await expect(manager.resetLocalCache('wrong-password')).rejects.toThrow(/INCORRECT_PASSWORD/);
    expect(clearCalled).toBe(false);
  });

  test('calls wallet.clear() once the password checks out', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic('some mnemonic words', 'right-password'));
    // .invalid (RFC 2606) never resolves, so re-init fails at DNS everywhere,
    // including CI runners with network access.
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    let clearCalled = false;
    withWallet(manager, { clear: async () => { clearCalled = true; } });
    await expect(manager.resetLocalCache('right-password')).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(clearCalled).toBe(true);
  });
});

describe('WalletManager.generateMnemonic', () => {
  test('returns 12 words', () => {
    const manager = new WalletManager(inMemoryStore());
    expect(manager.generateMnemonic().trim().split(/\s+/)).toHaveLength(12);
  });
});

describe('WalletManager.getBalance', () => {
  // Regression: availableAssets kept the SDK's bigint amounts, so every
  // wallet holding an asset failed with "Could not serialize message".
  test('converts every asset amount, so the result survives extension messaging', async () => {
    const manager = new WalletManager(inMemoryStore());
    const asset = { assetId: 'a'.repeat(68), amount: 5n };
    withWallet(manager, {
      getBalance: async () =>
        ({
          boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
          settled: 0, preconfirmed: 0, available: 0, gated: 0, intentLocked: 0,
          recoverable: 0, pendingRecovery: 0, total: 0,
          assets: [asset], availableAssets: [asset],
        }) as never,
    });
    const balance = await manager.getBalance();
    expect(() => JSON.stringify(balance)).not.toThrow();
    expect(balance.assets).toEqual([{ assetId: asset.assetId, amount: 5 }]);
    expect(balance.availableAssets).toEqual([{ assetId: asset.assetId, amount: 5 }]);
  });
});

describe('WalletManager.getXOnlyPublicKey', () => {
  test('returns the hex-encoded raw identity key, not the address', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, { getAddress: async () => 'tark1someaddress' });
    const key = new Uint8Array(32).fill(7);
    (manager as unknown as { identity: unknown }).identity = { xOnlyPublicKey: async () => key };
    expect(await manager.getXOnlyPublicKey()).toBe('07'.repeat(32));
  });

  test('throws while locked', async () => {
    await expect(new WalletManager(inMemoryStore()).getXOnlyPublicKey()).rejects.toThrow(/Wallet is locked/);
  });
});

describe('WalletManager.reconnect', () => {
  test('needs a cached password', async () => {
    await expect(new WalletManager(inMemoryStore()).reconnect()).rejects.toThrow(/Wallet is locked/);
  });

  test('re-initializes the active account with the cached password, without asking for it', async () => {
    const store = inMemoryStore();
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await saveEncryptedMnemonic(store, await encryptMnemonic(mnemonic, 'pw'));
    const manager = new WalletManager(store);
    withPassword(manager, 'pw');
    const calls: unknown[][] = [];
    (manager as unknown as { _initWallet: (...a: unknown[]) => Promise<void> })._initWallet = async (...args) => {
      calls.push(args);
    };
    await manager.reconnect();
    expect(calls).toEqual([[mnemonic, 'pw', 0, 0]]);
  });

  test('an unreachable new server reports SERVER_UNREACHABLE and leaves the wallet locked', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'pw'));
    await saveNetworkSettings(store, { arkServerUrl: 'https://ark.invalid/', esploraUrl: 'https://esplora.invalid/' });
    const manager = new WalletManager(store);
    withPassword(manager, 'pw');
    await expect(manager.reconnect()).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(manager.isUnlocked()).toBe(false);
    await expect(manager.addAccount()).rejects.toThrow(/Wallet is locked/);
  });
});

describe('WalletManager unlock failure', () => {
  test('a failed init never leaves the wallet unlocked with the password cached', async () => {
    const store = inMemoryStore();
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await saveEncryptedMnemonic(store, await encryptMnemonic(mnemonic, 'pw'));
    const manager = new WalletManager(store);
    const internals = manager as unknown as { _doInitWallet: () => Promise<void>; wallet: unknown; password: string };
    internals._doInitWallet = async () => {
      internals.wallet = {};
      internals.password = 'pw';
      throw new Error('exit init failed');
    };
    await expect(manager.unlock('pw')).rejects.toThrow(/SERVER_UNREACHABLE/);
    expect(manager.isUnlocked()).toBe(false);
    await expect(manager.addAccount()).rejects.toThrow(/Wallet is locked/);
  });
});

describe('WalletManager.sendOnchain input selection', () => {
  // Regression: offboard bundled the asset-carrying VTXO too, and the server
  // rejected the batch ("asset output not found in asset group").
  test('leaves VTXOs carrying an asset out of the offboard', async () => {
    const manager = new WalletManager(inMemoryStore());
    const plain = { txid: 'a'.repeat(64), vout: 0, value: 50_000, assets: [] };
    const withAsset = { txid: 'b'.repeat(64), vout: 0, value: 1_000, assets: [{ assetId: 'c'.repeat(68), amount: 1n }] };
    let settledInputs: Array<{ txid: string }> = [];
    withWallet(manager, {
      arkProvider: { getInfo: async () => ({ fees: { intentFee: {}, txFeeRate: '0' } }) } as never,
      getSpendableVtxos: async () => [plain, withAsset] as never,
      getAddress: async () => 'ark1change',
      settle: async (params) => {
        settledInputs = (params?.inputs ?? []) as Array<{ txid: string }>;
        return 'offboard-txid';
      },
    });
    const destination = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
    expect(await manager.sendOnchain(destination)).toBe('offboard-txid');
    expect(settledInputs.map((v) => v.txid)).toEqual([plain.txid]);
  });
});

describe('WalletManager onchain exit fee', () => {
  // Mainnet's real fee program at the time of writing: 200 sats per onchain output.
  const MAINNET_FEES = { intentFee: { offchainInput: '', offchainOutput: '', onchainInput: '', onchainOutput: '200.0' }, txFeeRate: '0' };
  const destination = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  // The SDK decodes the change address, so it has to be a real one.
  const changeAddress = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'tark').encode();

  function walletWithFees(
    onSettle: (outputs: Array<{ address: string; amount: bigint }>) => void,
    fees: typeof MAINNET_FEES = MAINNET_FEES,
  ) {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      arkProvider: { getInfo: async () => ({ fees }) } as never,
      getSpendableVtxos: async () => [{ txid: 'a'.repeat(64), vout: 0, value: 50_000, assets: [] }] as never,
      getAddress: async () => changeAddress,
      settle: async (params) => {
        onSettle((params?.outputs ?? []) as never);
        return 'txid';
      },
    });
    return manager;
  }

  test('quotes the fee on top of the amount', async () => {
    const manager = walletWithFees(() => undefined);
    expect(await manager.quoteOnchainSend(destination, 5_000)).toEqual({ amount: 5_000, fee: 200, total: 5_200 });
  });

  test('refuses a quote the asset-free VTXOs cannot cover, and says when VTXOs with an asset are why', async () => {
    const manager = new WalletManager(inMemoryStore());
    withWallet(manager, {
      arkProvider: { getInfo: async () => ({ fees: MAINNET_FEES }) } as never,
      getSpendableVtxos: async () =>
        [
          { txid: 'a'.repeat(64), vout: 0, value: 3_000, assets: [] },
          { txid: 'b'.repeat(64), vout: 0, value: 10_000, assets: [{ assetId: 'x', amount: 1n }] },
        ] as never,
      getAddress: async () => changeAddress,
    });
    expect(await manager.quoteOnchainSend(destination, 2_800)).toEqual({ amount: 2_800, fee: 200, total: 3_000 });
    await expect(manager.quoteOnchainSend(destination, 5_000)).rejects.toThrow(
      /this needs 5200 sats \(5000 \+ 200 fee\), and only 3000 sats can leave Arkade\. Another 10000 sats sit in VTXOs that also carry an asset/,
    );
    // Regression: entering exactly the asset-free total read "Only 3000 sats can leave", with no mention of the fee.
    await expect(manager.quoteOnchainSend(destination, 3_000)).rejects.toThrow(/this needs 3200 sats \(3000 \+ 200 fee\)/);
    const tooMuch = manager.quoteOnchainSend(destination, 20_000);
    await expect(tooMuch).rejects.toThrow(/this needs 20200 sats \(20000 \+ 200 fee\), and only 3000 sats can leave Arkade\.$/);
  });

  // Regression: the quote left out per-input fees, so it showed 468 + 200 = 668
  // as fitting in 669 sats while the SDK, netting 1 sat per input, refused it.
  describe('with a fee on each input', () => {
    const PER_INPUT_FEES = { ...MAINNET_FEES, intentFee: { ...MAINNET_FEES.intentFee, offchainInput: '1.0' } };

    function walletWith669Sats() {
      const manager = new WalletManager(inMemoryStore());
      withWallet(manager, {
        arkProvider: { getInfo: async () => ({ fees: PER_INPUT_FEES }) } as never,
        getSpendableVtxos: async () =>
          [
            { txid: 'a'.repeat(64), vout: 0, value: 400, assets: [] },
            { txid: 'c'.repeat(64), vout: 0, value: 269, assets: [] },
          ] as never,
        getAddress: async () => changeAddress,
        dustAmount: 330n,
      } as never);
      return manager;
    }

    test('counts every input the exit spends in the fee', async () => {
      const manager = walletWith669Sats();
      expect(await manager.quoteOnchainSend(destination, 467)).toEqual({ amount: 467, fee: 202, total: 669 });
      await expect(manager.quoteOnchainSend(destination, 468)).rejects.toThrow(/this needs 670 sats \(468 \+ 202 fee\), and only 669/);
    });

    test('refuses an amount that would leave change below dust', async () => {
      const manager = walletWith669Sats();
      await expect(manager.quoteOnchainSend(destination, 300)).rejects.toThrow(
        /leave 167 sats of change, below the 330-sat minimum.*Add 167 sats to the amount/,
      );
    });
  });

  test('the receiver gets exactly the amount entered; the fee leaves the wallet on top', async () => {
    let outputs: Array<{ address: string; amount: bigint }> = [];
    const manager = walletWithFees((o) => (outputs = o));
    await manager.sendOnchain(destination, 5_000);
    expect(outputs.find((o) => o.address === destination)?.amount).toBe(5_000n);
    expect(outputs.find((o) => o.address === changeAddress)?.amount).toBe(50_000n - 5_200n);
  });

  // Regression: grossing up and then offboarding priced the fee on the gross,
  // so under a 1% fee a 5000-sat exit paid the receiver 4999.
  test('the receiver gets exactly the amount entered under a fee that scales with it', async () => {
    const ONE_PERCENT = { ...MAINNET_FEES, intentFee: { ...MAINNET_FEES.intentFee, onchainOutput: 'double(amount) * 0.01' } };
    let outputs: Array<{ address: string; amount: bigint }> = [];
    const manager = walletWithFees((o) => (outputs = o), ONE_PERCENT);
    expect(await manager.quoteOnchainSend(destination, 5_000)).toEqual({ amount: 5_000, fee: 50, total: 5_050 });
    await manager.sendOnchain(destination, 5_000);
    expect(outputs.find((o) => o.address === destination)?.amount).toBe(5_000n);
  });
});

describe('WalletManager.sendOnchain with only asset VTXOs', () => {
  test('explains how to free the sats instead of a bare "no vtxos" error', async () => {
    const manager = new WalletManager(inMemoryStore());
    let settled = false;
    withWallet(manager, {
      arkProvider: { getInfo: async () => ({ fees: { intentFee: {}, txFeeRate: '0' } }) } as never,
      getSpendableVtxos: async () => [{ txid: 'a'.repeat(64), vout: 0, value: 46_766, assets: [{ assetId: 'x', amount: 1n }] }] as never,
      settle: async () => ((settled = true), 'txid'),
    });
    await expect(manager.sendOnchain('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 5_000)).rejects.toThrow(/Send the full amount of each asset to your own Ark address/);
    expect(settled).toBe(false);
  });
});

describe('WalletManager.sendOnchain validation', () => {
  test('rejects an invalid destination address before touching the wallet', async () => {
    const manager = new WalletManager(inMemoryStore());
    let called = false;
    withWallet(manager, { arkProvider: { getInfo: async () => ((called = true), {}) } as never });
    await expect(manager.sendOnchain('')).rejects.toThrow(/Invalid address/);
    expect(called).toBe(false);
  });

  test('rejects an invalid amount before touching the wallet', async () => {
    const manager = new WalletManager(inMemoryStore());
    let called = false;
    withWallet(manager, { arkProvider: { getInfo: async () => ((called = true), {}) } as never });
    await expect(manager.sendOnchain('bc1qaddr', -1)).rejects.toThrow(/Invalid amount/);
    expect(called).toBe(false);
  });
});

// Regression: one failed subscribe at unlock ended "funds received" pushes
// for the whole session.
describe('WalletManager incoming-funds watch', () => {
  type Internals = { startIncomingFundsWatch(w: unknown): void; stopIncomingFundsWatch(): void };
  const retryMs = WalletManager as unknown as { FUNDS_WATCH_RETRY_MS: number };
  const original = retryMs.FUNDS_WATCH_RETRY_MS;
  afterEach(() => {
    retryMs.FUNDS_WATCH_RETRY_MS = original;
  });

  test('retries a failed subscription until it works', async () => {
    retryMs.FUNDS_WATCH_RETRY_MS = 5;
    let attempts = 0;
    const wallet = {
      notifyIncomingFunds: async () => {
        attempts++;
        if (attempts === 1) throw new Error('server unreachable');
        return () => {};
      },
    };
    const manager = new WalletManager(inMemoryStore()) as unknown as Internals;
    manager.startIncomingFundsWatch(wallet);
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(2);
    manager.stopIncomingFundsWatch();
  });

  test('stops retrying once the watch is stopped', async () => {
    retryMs.FUNDS_WATCH_RETRY_MS = 5;
    let attempts = 0;
    const wallet = {
      notifyIncomingFunds: async () => {
        attempts++;
        throw new Error('server unreachable');
      },
    };
    const manager = new WalletManager(inMemoryStore()) as unknown as Internals;
    manager.startIncomingFundsWatch(wallet);
    await new Promise((r) => setTimeout(r, 1));
    manager.stopIncomingFundsWatch();
    const afterStop = attempts;
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(afterStop);
  });
});
