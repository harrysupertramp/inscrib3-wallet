import { computed, ref } from 'vue';
import { describeNetwork, type SerializableWalletBalance, type NetworkSettings, type AssetEntry, type AccountInfo, type ActiveAccount } from '@inscrib3/core';
import { useWalletClient } from '../wallet-client-key.js';

export function useWalletAddresses() {
  const address = ref('');
  const boardingAddress = ref('');
  const loading = ref(true);
  const error = ref('');
  const client = useWalletClient();

  async function refresh() {
    loading.value = true;
    error.value = '';
    try {
      [address.value, boardingAddress.value] = await Promise.all([
        client.getAddress(),
        client.getBoardingAddress(),
      ]);
    } catch (e: unknown) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  return { address, boardingAddress, loading, error, refresh };
}

export function useWalletBalance() {
  const balance = ref<SerializableWalletBalance | null>(null);
  const loading = ref(true);
  const error = ref('');
  const client = useWalletClient();

  async function refresh() {
    loading.value = true;
    error.value = '';
    try {
      balance.value = await client.getBalance();
    } catch (e: unknown) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  return { balance, loading, error, refresh };
}

export function useNetworkInfo() {
  const network = ref<string | null>(null);
  const esploraUrl = ref<string | null>(null);
  const client = useWalletClient();

  async function refresh() {
    try {
      const settings: NetworkSettings = await client.getNetworkSettings();
      const info = describeNetwork(settings);
      network.value = info.network;
      esploraUrl.value = info.esploraUrl;
    } catch {
      network.value = null;
      esploraUrl.value = null;
    }
  }

  return { network, esploraUrl, refresh };
}

// Asset display info for history rows: held assets from getAssets(), plus
// `extra` for ids resolved individually (e.g. assets sent away in full).
export function useAssets() {
  const assets = ref<AssetEntry[]>([]);
  const extra = ref(new Map<string, AssetEntry['metadata']>());
  const client = useWalletClient();

  const byId = computed(() => new Map(assets.value.map((a) => [a.assetId, a])));

  function metadataFor(assetId: string): AssetEntry['metadata'] {
    return byId.value.get(assetId)?.metadata ?? extra.value.get(assetId);
  }

  async function refresh() {
    try {
      assets.value = await client.getAssets();
    } catch {
      // keep the previous list on a transient failure
    }
  }

  // Skips ids already resolved, including ones with no metadata.
  async function ensureMetadata(assetIds: Iterable<string>): Promise<void> {
    const unresolved = [...new Set(assetIds)].filter((id) => !byId.value.has(id) && !extra.value.has(id));
    await Promise.all(
      unresolved.map(async (id) => {
        try {
          extra.value.set(id, await client.getAssetMetadata(id));
        } catch {
          // falls back to shortId; retried on the next call
        }
      }),
    );
  }

  function shortId(id: string): string {
    return `${id.slice(0, 6)}…`;
  }

  function label(assetId: string): string {
    return metadataFor(assetId)?.ticker ?? shortId(assetId);
  }

  function displayAmount(assetId: string, rawAmount: number): string {
    const decimals = metadataFor(assetId)?.decimals ?? 0;
    // Magnitude only: the SDK amount may already be negative, and callers add
    // their own sign.
    return (Math.abs(rawAmount) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: Math.max(decimals, 0) });
  }

  return { assets, byId, label, displayAmount, ensureMetadata, refresh };
}

export function useAccounts() {
  const accounts = ref<AccountInfo[]>([]);
  const active = ref<ActiveAccount>({ seedId: 0, index: 0 });
  const loading = ref(true);
  const error = ref('');
  const client = useWalletClient();

  async function refresh() {
    loading.value = true;
    error.value = '';
    try {
      [accounts.value, active.value] = await Promise.all([
        client.listAccounts(),
        client.getActiveAccount(),
      ]);
    } catch (e: unknown) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  return { accounts, active, loading, error, refresh };
}

// Public, no-auth price feed.
export function useBtcPrice() {
  const usdPrice = ref<number | null>(null);

  async function refresh() {
    try {
      const res = await fetch('https://mempool.space/api/v1/prices');
      const data = await res.json();
      usdPrice.value = typeof data.USD === 'number' ? data.USD : null;
    } catch {
      usdPrice.value = null;
    }
  }

  return { usdPrice, refresh };
}
