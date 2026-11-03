import { describe, expect, test } from 'bun:test';
import { TxType, type IWallet } from '@arkade-os/sdk';
import { AssetService } from './asset-service.js';

// Minimal shape matching what AssetService actually reads off IWallet - not
// the full SDK interface, which carries a lot more this service ignores.
function mockWallet(overrides: {
  assets?: Array<{ assetId: string; amount: bigint }>;
  assetDetails?: (assetId: string) => Promise<{ metadata?: { name?: string; ticker?: string; decimals?: number; icon?: string } }>;
  issue?: (params: unknown) => Promise<{ assetId: string; arkTxId: string }>;
  reissue?: (params: unknown) => Promise<string>;
  burn?: (params: unknown) => Promise<string>;
  txs?: Array<Record<string, unknown>>;
}) {
  return {
    getBalance: async () => ({ assets: overrides.assets ?? [] }),
    assetManager: {
      getAssetDetails: overrides.assetDetails ?? (async () => ({})),
      issue: overrides.issue ?? (async () => ({ assetId: 'a1', arkTxId: 'tx1' })),
      reissue: overrides.reissue ?? (async () => 'tx1'),
      burn: overrides.burn ?? (async () => 'tx1'),
    },
    getTransactionHistory: async () => overrides.txs ?? [],
  } as unknown as IWallet;
}

function mockTx(assetId: string | undefined, overrides: { arkTxid?: string; amount?: number } = {}) {
  return {
    key: { arkTxid: overrides.arkTxid ?? 'tx1', commitmentTxid: '', boardingTxid: '' },
    type: TxType.TxReceived,
    amount: overrides.amount ?? 1000,
    settled: true,
    createdAt: 1_700_000_000_000,
    assets: assetId ? [{ assetId, amount: 1n }] : undefined,
  };
}

describe('AssetService.getAssets', () => {
  test('computes displayAmount using the asset metadata decimals', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [{ assetId: 'a1', amount: 150n }],
      assetDetails: async () => ({ metadata: { name: 'Coin', ticker: 'CO', decimals: 2 } }),
    });
    const [asset] = await service.getAssets(wallet);
    expect(asset.amount).toBe(150);
    expect(asset.displayAmount).toBe(1.5);
  });

  test('defaults decimals to 0 when metadata is absent', async () => {
    const service = new AssetService();
    const wallet = mockWallet({ assets: [{ assetId: 'a1', amount: 150n }], assetDetails: async () => ({}) });
    const [asset] = await service.getAssets(wallet);
    expect(asset.displayAmount).toBe(150);
    expect(asset.metadata).toBeUndefined();
  });

  test('falls back to no metadata when the details fetch throws', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [{ assetId: 'a1', amount: 100n }],
      assetDetails: async () => {
        throw new Error('network error');
      },
    });
    const [asset] = await service.getAssets(wallet);
    expect(asset.metadata).toBeUndefined();
    expect(asset.displayAmount).toBe(100);
  });

  test('derives genesisTxid as the first 64 hex chars of the assetId', async () => {
    const service = new AssetService();
    const genesisTxid = 'a'.repeat(64);
    const wallet = mockWallet({ assets: [{ assetId: `${genesisTxid}0001`, amount: 1n }] });
    const [asset] = await service.getAssets(wallet);
    expect(asset.genesisTxid).toBe(genesisTxid);
  });

  test('keeps an https icon URL', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [{ assetId: 'a1', amount: 1n }],
      assetDetails: async () => ({ metadata: { icon: 'https://example.com/icon.png' } }),
    });
    const [asset] = await service.getAssets(wallet);
    expect(asset.metadata?.icon).toBe('https://example.com/icon.png');
  });

  test('drops a non-http(s) icon URL (tracking-pixel/beacon risk)', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [{ assetId: 'a1', amount: 1n }],
      assetDetails: async () => ({ metadata: { icon: 'javascript:alert(1)' } }),
    });
    const [asset] = await service.getAssets(wallet);
    expect(asset.metadata?.icon).toBeUndefined();
  });

  test('drops a malformed icon URL', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [{ assetId: 'a1', amount: 1n }],
      assetDetails: async () => ({ metadata: { icon: 'not a url' } }),
    });
    const [asset] = await service.getAssets(wallet);
    expect(asset.metadata?.icon).toBeUndefined();
  });
});

describe('AssetService.getAssetMetadata', () => {
  test('resolves metadata for an assetId the wallet holds no balance of', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assets: [],
      assetDetails: async () => ({ metadata: { name: 'Coin', ticker: 'CO', decimals: 2 } }),
    });
    const metadata = await service.getAssetMetadata(wallet, 'a1');
    expect(metadata).toEqual({ name: 'Coin', ticker: 'CO', decimals: 2, icon: undefined });
  });

  test('returns undefined when the details fetch throws', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      assetDetails: async () => {
        throw new Error('network error');
      },
    });
    const metadata = await service.getAssetMetadata(wallet, 'a1');
    expect(metadata).toBeUndefined();
  });
});

describe('AssetService.issue', () => {
  test('rejects an invalid amount without calling assetManager.issue', async () => {
    const service = new AssetService();
    let called = false;
    const wallet = mockWallet({
      issue: async () => {
        called = true;
        return { assetId: 'a1', arkTxId: 'tx1' };
      },
    });
    await expect(service.issue(wallet, -1)).rejects.toThrow(/Invalid amount/);
    expect(called).toBe(false);
  });

  test('rejects an invalid controlAssetId', async () => {
    const service = new AssetService();
    const wallet = mockWallet({});
    await expect(service.issue(wallet, 100, undefined, '   ')).rejects.toThrow(/Invalid controlAssetId/);
  });

  test('converts amount to BigInt and passes metadata/controlAssetId through', async () => {
    const service = new AssetService();
    let receivedParams: unknown;
    const wallet = mockWallet({
      issue: async (params) => {
        receivedParams = params;
        return { assetId: 'a1', arkTxId: 'tx1' };
      },
    });
    await service.issue(wallet, 500, { ticker: 'CO' }, 'control-1');
    expect(receivedParams).toEqual({ amount: 500n, metadata: { ticker: 'CO' }, controlAssetId: 'control-1' });
  });
});

describe('AssetService.reissue / burn', () => {
  test('reissue rejects an invalid assetId', async () => {
    const service = new AssetService();
    await expect(service.reissue(mockWallet({}), '', 100)).rejects.toThrow(/Invalid assetId/);
  });

  test('reissue rejects an invalid amount', async () => {
    const service = new AssetService();
    await expect(service.reissue(mockWallet({}), 'a1', 0)).rejects.toThrow(/Invalid amount/);
  });

  test('reissue converts amount to BigInt', async () => {
    const service = new AssetService();
    let receivedParams: unknown;
    const wallet = mockWallet({
      reissue: async (params) => {
        receivedParams = params;
        return 'txid';
      },
    });
    await service.reissue(wallet, 'a1', 250);
    expect(receivedParams).toEqual({ assetId: 'a1', amount: 250n });
  });

  test('burn rejects an invalid assetId', async () => {
    const service = new AssetService();
    await expect(service.burn(mockWallet({}), '', 100)).rejects.toThrow(/Invalid assetId/);
  });

  test('burn converts amount to BigInt', async () => {
    const service = new AssetService();
    let receivedParams: unknown;
    const wallet = mockWallet({
      burn: async (params) => {
        receivedParams = params;
        return 'txid';
      },
    });
    await service.burn(wallet, 'a1', 75);
    expect(receivedParams).toEqual({ assetId: 'a1', amount: 75n });
  });
});

describe('AssetService.getTransactionHistory', () => {
  test('filters transactions to only those moving the given assetId', async () => {
    const service = new AssetService();
    const wallet = mockWallet({
      txs: [
        mockTx('asset-1', { arkTxid: 'tx1' }),
        mockTx('asset-2', { arkTxid: 'tx2' }),
        mockTx(undefined, { arkTxid: 'tx3' }),
      ],
    });
    const history = await service.getTransactionHistory(wallet, 'asset-1', new Set());
    expect(history.map((h) => h.txid)).toEqual(['tx1']);
  });

  test('returns an empty list when no transaction moves the asset', async () => {
    const service = new AssetService();
    const wallet = mockWallet({ txs: [mockTx('other-asset')] });
    const history = await service.getTransactionHistory(wallet, 'asset-1', new Set());
    expect(history).toEqual([]);
  });
});
