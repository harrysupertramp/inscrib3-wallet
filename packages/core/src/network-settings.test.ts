import { describe, expect, test } from 'bun:test';
import {
  NETWORK_PRESETS,
  DEFAULT_NETWORK_SETTINGS,
  loadNetworkSettings,
  saveNetworkSettings,
  describeNetwork,
  getDelegateUrl,
  getArkadeExplorerTxUrl,
  getMempoolTxUrl,
} from './network-settings.js';
import { inMemoryStore } from './test-helpers.js';

describe('loadNetworkSettings', () => {
  test('returns the default settings when nothing has been saved', async () => {
    const settings = await loadNetworkSettings(inMemoryStore());
    expect(settings).toEqual(DEFAULT_NETWORK_SETTINGS);
  });

  test('returns whatever was previously saved', async () => {
    const store = inMemoryStore();
    await saveNetworkSettings(store, { arkServerUrl: NETWORK_PRESETS[1].arkServerUrl, esploraUrl: NETWORK_PRESETS[1].esploraUrl });
    const settings = await loadNetworkSettings(store);
    expect(settings.arkServerUrl).toBe(NETWORK_PRESETS[1].arkServerUrl);
  });
});

describe('saveNetworkSettings URL validation', () => {
  test('accepts a valid https URL pair', async () => {
    await expect(saveNetworkSettings(inMemoryStore(), { arkServerUrl: 'https://example.com', esploraUrl: 'https://example.com/api' })).resolves.toBeUndefined();
  });

  test('rejects a non-URL string', async () => {
    await expect(saveNetworkSettings(inMemoryStore(), { arkServerUrl: 'not a url', esploraUrl: 'https://example.com' })).rejects.toThrow(/Invalid Ark server URL/);
  });

  test('rejects an empty string (would silently produce relative-path fetches)', async () => {
    await expect(saveNetworkSettings(inMemoryStore(), { arkServerUrl: '', esploraUrl: 'https://example.com' })).rejects.toThrow();
  });

  test('rejects a javascript: scheme', async () => {
    await expect(saveNetworkSettings(inMemoryStore(), { arkServerUrl: 'javascript:alert(1)', esploraUrl: 'https://example.com' })).rejects.toThrow(/must be http or https/);
  });

  test('rejects a URL with embedded credentials (phishing pattern)', async () => {
    await expect(
      saveNetworkSettings(inMemoryStore(), { arkServerUrl: 'https://arkade.computer@evil.com/', esploraUrl: 'https://example.com' }),
    ).rejects.toThrow(/embedded credentials/);
  });

  test('validates the esplora URL too, not just the ark server URL', async () => {
    await expect(
      saveNetworkSettings(inMemoryStore(), { arkServerUrl: 'https://example.com', esploraUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow(/Invalid Esplora URL/);
  });
});

describe('describeNetwork', () => {
  test('recognizes a known preset', () => {
    const info = describeNetwork({ arkServerUrl: NETWORK_PRESETS[0].arkServerUrl, esploraUrl: NETWORK_PRESETS[0].esploraUrl });
    expect(info.network).toBe(NETWORK_PRESETS[0].network);
    expect(info.displayName).toBe(NETWORK_PRESETS[0].displayName);
  });

  test('mainnet preset is not reported as testnet', () => {
    const mainnet = NETWORK_PRESETS.find((p) => p.network === 'bitcoin')!;
    const info = describeNetwork({ arkServerUrl: mainnet.arkServerUrl, esploraUrl: mainnet.esploraUrl });
    expect(info.isTestnet).toBe(false);
  });

  test('an unrecognized custom server is reported as "custom", not guessed at', () => {
    const info = describeNetwork({ arkServerUrl: 'https://my-own-server.example', esploraUrl: 'https://example.com' });
    expect(info.network).toBe('custom');
    expect(info.displayName).toBe('Custom');
    expect(info.isTestnet).toBe(true);
  });
});

describe('getDelegateUrl', () => {
  test('mainnet resolves to the Arkade delegation service', () => {
    const mainnet = NETWORK_PRESETS.find((p) => p.network === 'bitcoin')!;
    expect(getDelegateUrl(mainnet.arkServerUrl)).toBe('https://delegate.arkade.money');
  });

  test('mutinynet has no delegate service deployed', () => {
    const mutinynet = NETWORK_PRESETS.find((p) => p.network === 'mutinynet')!;
    expect(getDelegateUrl(mutinynet.arkServerUrl)).toBeNull();
  });

  // A stranger's delegate key must never end up in a script a custom
  // server never agreed to sign.
  test('a custom server never inherits a delegate', () => {
    expect(getDelegateUrl('https://my-own-server.example')).toBeNull();
  });

  // Regression: another spelling of the mainnet URL counted as "Custom", so
  // the delegate leaf was dropped and funds at the 3-leaf address seemed gone.
  test('other spellings of the mainnet URL still resolve the delegate and the preset', () => {
    for (const url of ['https://arkade.computer/', 'HTTPS://ARKADE.COMPUTER', 'https://arkade.computer:443']) {
      expect(getDelegateUrl(url)).toBe('https://delegate.arkade.money');
      expect(describeNetwork({ arkServerUrl: url, esploraUrl: 'https://mempool.arkade.sh/api' })).toMatchObject({ network: 'bitcoin', isTestnet: false });
    }
  });

  test('a different host is still not the preset', () => {
    expect(getDelegateUrl('https://arkade.computer.evil.example')).toBeNull();
  });
});

describe('server URL spelling', () => {
  test('is saved in one canonical form, and older spellings load in that form', async () => {
    const store = inMemoryStore();
    await saveNetworkSettings(store, { arkServerUrl: 'https://Arkade.Computer:443/', esploraUrl: 'https://mempool.arkade.sh/api' });
    expect((await loadNetworkSettings(store)).arkServerUrl).toBe('https://arkade.computer');
    await store.set('arkade:settings:network', { arkServerUrl: 'https://mutinynet.arkade.sh/', esploraUrl: 'https://mutinynet.com/api' });
    expect((await loadNetworkSettings(store)).arkServerUrl).toBe('https://mutinynet.arkade.sh');
  });
});

describe('getArkadeExplorerTxUrl', () => {
  test('returns a real URL for mainnet', () => {
    expect(getArkadeExplorerTxUrl('bitcoin', 'abc123')).toBe('https://arkade.space/tx/abc123');
  });

  test('uses the Mutinynet deployment on Mutinynet', () => {
    expect(getArkadeExplorerTxUrl('mutinynet', 'abc123')).toBe('https://explorer.mutinynet.arkade.sh/tx/abc123');
  });

  test('returns null for custom networks or an empty txid', () => {
    expect(getArkadeExplorerTxUrl('custom', 'abc123')).toBeNull();
    expect(getArkadeExplorerTxUrl('bitcoin', '')).toBeNull();
  });
});

describe('getMempoolTxUrl', () => {
  test('strips the /api suffix and appends the tx path', () => {
    expect(getMempoolTxUrl('https://mempool.arkade.sh/api', 'abc123')).toBe('https://mempool.arkade.sh/tx/abc123');
  });

  test('works for any esplora URL, not just the built-in presets (a custom server)', () => {
    expect(getMempoolTxUrl('https://my-own-esplora.example/api', 'abc123')).toBe('https://my-own-esplora.example/tx/abc123');
  });

  test('handles an esplora URL with no /api suffix', () => {
    expect(getMempoolTxUrl('https://mutinynet.com', 'abc123')).toBe('https://mutinynet.com/tx/abc123');
  });

  test('returns null when the esplora URL is empty', () => {
    expect(getMempoolTxUrl('', 'abc123')).toBeNull();
  });

  test('returns null when the txid is empty', () => {
    expect(getMempoolTxUrl('https://mempool.arkade.sh/api', '')).toBeNull();
  });
});
