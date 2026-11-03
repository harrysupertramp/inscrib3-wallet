import type { KeyValueStore } from './key-value-store.js';

const STORAGE_KEY = 'arkade:settings:network';

export interface NetworkSettings {
  arkServerUrl: string;
  esploraUrl: string;
}

export interface NetworkPreset {
  // The value ArkadeInfo.network reports for this server.
  network: string;
  displayName: string;
  arkServerUrl: string;
  esploraUrl: string;
  // Its pubkey becomes a third tapleaf, which changes the derived address.
  delegateUrl?: string;
}

// Signet is not a preset; it still works as a custom URL.
export const NETWORK_PRESETS: NetworkPreset[] = [
  {
    network: 'bitcoin',
    displayName: 'Mainnet',
    arkServerUrl: 'https://arkade.computer',
    esploraUrl: 'https://mempool.arkade.sh/api',
    delegateUrl: 'https://delegate.arkade.money',
  },
  {
    network: 'mutinynet',
    displayName: 'Mutinynet (testnet)',
    arkServerUrl: 'https://mutinynet.arkade.sh',
    esploraUrl: 'https://mutinynet.com/api',
  },
];

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  arkServerUrl: NETWORK_PRESETS[0].arkServerUrl,
  esploraUrl: NETWORK_PRESETS[0].esploraUrl,
};

// One spelling per server: a trailing slash, capitals or an explicit default
// port must not turn the mainnet preset into "Custom", which drops the
// delegate leaf and so hides the funds at the 3-leaf address.
export function canonicalServerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

export async function loadNetworkSettings(store: KeyValueStore): Promise<NetworkSettings> {
  const stored = await store.get<NetworkSettings>(STORAGE_KEY);
  if (!stored) return DEFAULT_NETWORK_SETTINGS;
  // Settings saved before canonicalization may still hold another spelling.
  return { ...stored, arkServerUrl: canonicalServerUrl(stored.arkServerUrl) };
}

// Rejects embedded credentials (https://arkade.computer@evil.com/), a phishing
// pattern where the URL appears to start with a trusted host.
function assertValidServerUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${label}: not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label}: must be http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid ${label}: must not contain embedded credentials`);
  }
}

export async function saveNetworkSettings(store: KeyValueStore, settings: NetworkSettings): Promise<void> {
  assertValidServerUrl(settings.arkServerUrl, 'Ark server URL');
  assertValidServerUrl(settings.esploraUrl, 'Esplora URL');
  await store.set(STORAGE_KEY, { ...settings, arkServerUrl: canonicalServerUrl(settings.arkServerUrl) });
}

export interface NetworkInfo {
  network: string;
  displayName: string;
  isTestnet: boolean;
  arkServerUrl: string;
  esploraUrl: string;
}

const KNOWN_NETWORKS: Record<string, NetworkPreset> = Object.fromEntries(
  NETWORK_PRESETS.map((preset) => [preset.arkServerUrl, preset]),
);

// Presets only: pointing a custom server at Ark Labs' delegator would put a
// key into scripts that server never agreed to. Mutinynet has no delegator.
export function getDelegateUrl(arkServerUrl: string): string | null {
  return KNOWN_NETWORKS[canonicalServerUrl(arkServerUrl)]?.delegateUrl ?? null;
}

export function describeNetwork(settings: NetworkSettings): NetworkInfo {
  const known = KNOWN_NETWORKS[canonicalServerUrl(settings.arkServerUrl)];
  return {
    network: known?.network ?? 'custom',
    displayName: known?.displayName ?? 'Custom',
    // Display-only guess; WalletManager asks the server for the real network.
    isTestnet: known === undefined || known.network !== 'bitcoin',
    arkServerUrl: settings.arkServerUrl,
    esploraUrl: settings.esploraUrl,
  };
}

// Each network has its own Arkade Explorer deployment; custom servers have none.
const ARKADE_EXPLORERS: Record<string, string> = {
  bitcoin: 'https://arkade.space',
  mutinynet: 'https://explorer.mutinynet.arkade.sh',
};

// For Ark-layer txids (offchain sends, Lightning swaps). L1 txids go to
// getMempoolTxUrl instead.
export function getArkadeExplorerTxUrl(network: string, txid: string): string | null {
  const base = ARKADE_EXPLORERS[network];
  return base && txid ? `${base}/tx/${txid}` : null;
}

// For L1 txids only (boarding sends, commitment txs). Esplora-family
// explorers serve their tx pages from the same host as /api.
export function getMempoolTxUrl(esploraUrl: string, txid: string): string | null {
  if (!esploraUrl || !txid) return null;
  const base = esploraUrl.replace(/\/api\/?$/, '');
  return `${base}/tx/${txid}`;
}
