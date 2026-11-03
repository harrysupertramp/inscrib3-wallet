import { describe, expect, test } from 'bun:test';
import { MnemonicIdentity, type OnchainProvider } from '@arkade-os/sdk';
import { ExitService } from './exit-service.js';
import { inMemoryStore } from './test-helpers.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// OnchainWallet.create() only reads the identity's pubkey and stores this
// provider - none of its methods are invoked during init(), so a stub with
// no real network access is enough.
function fakeOnchainProvider(): OnchainProvider {
  return {
    getCoins: async () => [],
    getFeeRate: async () => undefined,
    broadcastTransaction: async () => 'txid',
    getTxOutspends: async () => [],
    getTransactions: async () => [],
    getTxStatus: async () => ({ confirmed: false }) as const,
    getChainTip: async () => ({ height: 0, time: 0, hash: '' }),
    watchAddresses: async () => () => {},
  } as unknown as OnchainProvider;
}

async function initializedService(network: 'mutinynet' | 'bitcoin' = 'mutinynet', accountIndex = 0) {
  const store = inMemoryStore();
  const service = new ExitService(store);
  const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: network === 'bitcoin' });
  await service.init(identity, network, fakeOnchainProvider(), accountIndex);
  return { service, store };
}

describe('ExitService locked-state guards', () => {
  test('getFeeAddress throws before init()', () => {
    const service = new ExitService(inMemoryStore());
    expect(() => service.getFeeAddress()).toThrow(/Wallet is locked/);
  });

  // Regression: the recovery screen asked users to fund the boarding address,
  // which the exit never spends fees from.
  test('getFeeAddress is the plain Taproot address, not the boarding address', async () => {
    const { service } = await initializedService('bitcoin');
    // The official BIP86 test vector (m/86'/0'/0'/0/0) for TEST_MNEMONIC.
    expect(service.getFeeAddress()).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  });

  test('dispose() re-locks - getFeeAddress throws again', async () => {
    const { service } = await initializedService();
    service.dispose();
    expect(() => service.getFeeAddress()).toThrow(/Wallet is locked/);
  });

  test('hasPending() is false with nothing stored', async () => {
    const { service } = await initializedService();
    expect(await service.hasPending()).toBe(false);
  });
});

describe('ExitService network scoping', () => {
  // Mirror the non-exported storage keys in exit-service.ts.
  const LEGACY_KEY = 'arkade:exit:package';
  const keyFor = (network: string) => `arkade:exit:package:${network}`;

  test('a package stored for the current network is reported pending', async () => {
    const { service, store } = await initializedService('mutinynet');
    await store.set(keyFor('mutinynet'), { network: 'mutinynet', serializedPackage: 'x' });
    expect(await service.hasPending()).toBe(true);
  });

  // Regression: switching network deleted an exit that can take days to finish.
  test('a package for another network is not pending here, and is kept', async () => {
    const { service, store } = await initializedService('mutinynet');
    await store.set(keyFor('bitcoin'), { network: 'bitcoin', serializedPackage: 'x' });
    await store.set(LEGACY_KEY, { network: 'bitcoin', serializedPackage: 'old' });
    expect(await service.hasPending()).toBe(false);
    expect(await store.get(keyFor('bitcoin'))).toEqual({ network: 'bitcoin', serializedPackage: 'x' });
    expect(await store.get(LEGACY_KEY)).toEqual({ network: 'bitcoin', serializedPackage: 'old' });
  });

  test('a package under the pre-network key moves to the new key on its own network', async () => {
    const { service, store } = await initializedService('mutinynet');
    await store.set(LEGACY_KEY, { network: 'mutinynet', serializedPackage: 'x' });
    expect(await service.hasPending()).toBe(true);
    expect(await store.get(keyFor('mutinynet'))).toEqual({ network: 'mutinynet', serializedPackage: 'x' });
    expect(await store.get(LEGACY_KEY)).toBeNull();
  });

  // Regression: while locked the network is unknown, which read as a mismatch.
  test('while locked nothing is pending and the stored package is untouched', async () => {
    const { service, store } = await initializedService('mutinynet');
    await store.set(LEGACY_KEY, { network: 'mutinynet', serializedPackage: 'x' });
    service.dispose();
    expect(await service.hasPending()).toBe(false);
    expect(await store.get(LEGACY_KEY)).toEqual({ network: 'mutinynet', serializedPackage: 'x' });
  });
});

describe('ExitService per-account scoping', () => {
  test('account 0 still finds a package under the key existing installs used', async () => {
    const EXIT_PACKAGE_STORAGE_KEY = 'arkade:exit:package';
    const { service, store } = await initializedService('mutinynet', 0);
    await store.set(EXIT_PACKAGE_STORAGE_KEY, { network: 'mutinynet', serializedPackage: 'x' });
    expect(await service.hasPending()).toBe(true);
  });

  test('a package pending for account 0 is not visible to account 1 on the same network', async () => {
    const store = inMemoryStore();
    await store.set('arkade:exit:package', { network: 'mutinynet', serializedPackage: 'x' });

    const service1 = new ExitService(store);
    const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: false });
    await service1.init(identity, 'mutinynet', fakeOnchainProvider(), 1);

    expect(await service1.hasPending()).toBe(false);
  });

  test('two accounts on the same network can each have their own pending package', async () => {
    const store = inMemoryStore();
    await store.set('arkade:exit:package', { network: 'mutinynet', serializedPackage: 'account-0' });
    await store.set('arkade:exit:package:1', { network: 'mutinynet', serializedPackage: 'account-1' });

    const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: false });
    const service0 = new ExitService(store);
    await service0.init(identity, 'mutinynet', fakeOnchainProvider(), 0);
    const service1 = new ExitService(store);
    await service1.init(identity, 'mutinynet', fakeOnchainProvider(), 1);

    expect(await service0.hasPending()).toBe(true);
    expect(await service1.hasPending()).toBe(true);
  });
});

describe('ExitService.start re-entrancy guard', () => {
  test('a second concurrent start() call is rejected while the first is in flight', async () => {
    const { service } = await initializedService();
    const fakeWallet = {} as unknown as Parameters<typeof service.start>[0];

    const first = service.start(fakeWallet, 'bc1qsweepaddress').catch((e) => e);
    const second = service.start(fakeWallet, 'bc1qsweepaddress').catch((e) => e);
    const [, secondResult] = await Promise.all([first, second]);

    expect(String(secondResult)).toMatch(/already in progress/);
  });
});
