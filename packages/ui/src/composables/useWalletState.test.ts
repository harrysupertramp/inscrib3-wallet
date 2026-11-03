import { describe, expect, test, afterEach } from 'bun:test';
import { createApp } from 'vue';
import type { WalletClient } from '@inscrib3/core';
import { WALLET_CLIENT_KEY } from '../wallet-client-key.js';
import { useWalletAddresses, useWalletBalance, useNetworkInfo, useBtcPrice, useAssets, useAccounts } from './useWalletState.js';

// useWalletClient() reads from Vue's injection context, which only exists
// during component setup - runWithContext() is Vue's supported way to
// reproduce that context for testing a composable in isolation.
function withProvidedClient<T>(client: Partial<WalletClient>, fn: () => T): T {
  const app = createApp({});
  app.provide(WALLET_CLIENT_KEY, client as WalletClient);
  return app.runWithContext(fn);
}

describe('useWalletAddresses', () => {
  test('populates address and boardingAddress on refresh', async () => {
    const { address, boardingAddress, loading, error, refresh } = withProvidedClient(
      { getAddress: async () => 'ark1qaddr', getBoardingAddress: async () => 'bc1qboarding' },
      () => useWalletAddresses(),
    );
    expect(loading.value).toBe(true);
    await refresh();
    expect(address.value).toBe('ark1qaddr');
    expect(boardingAddress.value).toBe('bc1qboarding');
    expect(loading.value).toBe(false);
    expect(error.value).toBe('');
  });

  test('captures the error message and clears loading on failure', async () => {
    const { error, loading, refresh } = withProvidedClient(
      {
        getAddress: async () => {
          throw new Error('server unreachable');
        },
        getBoardingAddress: async () => 'bc1qboarding',
      },
      () => useWalletAddresses(),
    );
    await refresh();
    expect(error.value).toContain('server unreachable');
    expect(loading.value).toBe(false);
  });
});

describe('useWalletBalance', () => {
  test('populates balance on refresh', async () => {
    const balancePayload = { settled: 1000, preconfirmed: 0, available: 1000, recoverable: 0, total: 1000, boarding: { confirmed: 0, unconfirmed: 0, total: 0 }, assets: [] };
    const { balance, refresh } = withProvidedClient({ getBalance: async () => balancePayload as never }, () => useWalletBalance());
    await refresh();
    expect(balance.value).toEqual(balancePayload as never);
  });

  test('leaves balance null and records the error on failure', async () => {
    const { balance, error, refresh } = withProvidedClient(
      {
        getBalance: async () => {
          throw new Error('locked');
        },
      },
      () => useWalletBalance(),
    );
    await refresh();
    expect(balance.value).toBeNull();
    expect(error.value).toContain('locked');
  });
});

describe('useNetworkInfo', () => {
  test('resolves the short network name from settings', async () => {
    const { network, refresh } = withProvidedClient(
      { getNetworkSettings: async () => ({ arkServerUrl: 'https://mutinynet.arkade.sh', esploraUrl: 'https://mutinynet.esplora' }) },
      () => useNetworkInfo(),
    );
    await refresh();
    expect(network.value).toBe('mutinynet');
  });

  test('falls back to null when the settings fetch fails', async () => {
    const { network, refresh } = withProvidedClient(
      {
        getNetworkSettings: async () => {
          throw new Error('locked');
        },
      },
      () => useNetworkInfo(),
    );
    await refresh();
    expect(network.value).toBeNull();
  });
});

describe('useAssets', () => {
  const asset = { assetId: 'asset-1', amount: 100, displayAmount: 1, genesisTxid: 'genesis-1', metadata: { ticker: 'MTK', decimals: 2 } };

  test('label resolves the ticker for a known asset', async () => {
    const { label, refresh } = withProvidedClient({ getAssets: async () => [asset] }, () => useAssets());
    await refresh();
    expect(label('asset-1')).toBe('MTK');
  });

  test('label falls back to a shortened assetId for an unknown asset', async () => {
    const { label, refresh } = withProvidedClient({ getAssets: async () => [] }, () => useAssets());
    await refresh();
    expect(label('deadbeef1234')).toBe('deadbe…');
  });

  test('displayAmount applies decimals from the resolved asset', async () => {
    const { displayAmount, refresh } = withProvidedClient({ getAssets: async () => [asset] }, () => useAssets());
    await refresh();
    expect(displayAmount('asset-1', 250)).toBe('2.5');
  });

  // Magnitude only: callers add their own sign.
  test('displayAmount returns a magnitude, not a signed value', async () => {
    const { displayAmount, refresh } = withProvidedClient({ getAssets: async () => [asset] }, () => useAssets());
    await refresh();
    expect(displayAmount('asset-1', -250)).toBe('2.5');
  });

  // A fully-sent asset drops out of getAssets(), but ensureMetadata() still
  // resolves it.
  test('ensureMetadata resolves label/displayAmount for an asset no longer held', async () => {
    const { label, displayAmount, ensureMetadata, refresh } = withProvidedClient(
      {
        getAssets: async () => [],
        getAssetMetadata: async (assetId) =>
          assetId === 'sent-away' ? { ticker: 'GONE', decimals: 3 } : undefined,
      },
      () => useAssets(),
    );
    await refresh();
    expect(label('sent-away')).toBe('sent-a…');
    await ensureMetadata(['sent-away']);
    expect(label('sent-away')).toBe('GONE');
    expect(displayAmount('sent-away', 2500)).toBe('2.5');
  });

  test('ensureMetadata does not refetch an assetId already resolved from getAssets()', async () => {
    let calls = 0;
    const { label, ensureMetadata, refresh } = withProvidedClient(
      {
        getAssets: async () => [asset],
        getAssetMetadata: async () => {
          calls++;
          return { ticker: 'SHOULD-NOT-BE-USED' };
        },
      },
      () => useAssets(),
    );
    await refresh();
    await ensureMetadata(['asset-1']);
    expect(label('asset-1')).toBe('MTK');
    expect(calls).toBe(0);
  });
});

describe('useAccounts', () => {
  test('populates accounts and active on refresh', async () => {
    const { accounts, active, loading, error, refresh } = withProvidedClient(
      {
        listAccounts: async () => [
          { seedId: 0, index: 0, label: 'Main' },
          { seedId: 0, index: 1, label: 'Savings' },
        ],
        getActiveAccount: async () => ({ seedId: 0, index: 1 }),
      },
      () => useAccounts(),
    );
    expect(loading.value).toBe(true);
    await refresh();
    expect(accounts.value).toEqual([
      { seedId: 0, index: 0, label: 'Main' },
      { seedId: 0, index: 1, label: 'Savings' },
    ]);
    expect(active.value).toEqual({ seedId: 0, index: 1 });
    expect(loading.value).toBe(false);
    expect(error.value).toBe('');
  });

  test('captures the error message and clears loading on failure', async () => {
    const { error, loading, refresh } = withProvidedClient(
      {
        listAccounts: async () => {
          throw new Error('locked');
        },
        getActiveAccount: async () => ({ seedId: 0, index: 0 }),
      },
      () => useAccounts(),
    );
    await refresh();
    expect(error.value).toContain('locked');
    expect(loading.value).toBe(false);
  });
});

describe('useBtcPrice', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('reads the USD price from the response', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ USD: 65000 }))) as unknown as typeof fetch;
    const { usdPrice, refresh } = useBtcPrice();
    await refresh();
    expect(usdPrice.value).toBe(65000);
  });

  test('is null when the response has no numeric USD field', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ EUR: 60000 }))) as unknown as typeof fetch;
    const { usdPrice, refresh } = useBtcPrice();
    await refresh();
    expect(usdPrice.value).toBeNull();
  });

  test('is null when the fetch throws', async () => {
    global.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { usdPrice, refresh } = useBtcPrice();
    await refresh();
    expect(usdPrice.value).toBeNull();
  });
});
