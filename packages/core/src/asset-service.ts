import type { IWallet } from '@arkade-os/sdk';
import { toHistoryEntry, type TxHistoryEntry } from './tx-history.js';

// An assetId is the 32-byte genesis txid followed by a 2-byte group index.
function genesisTxidFromAssetId(assetId: string): string {
  return assetId.slice(0, 64);
}

// metadata.icon is issuer-controlled and assets arrive without opt-in, so only
// http(s) is allowed. An https URL can still act as a tracking beacon.
function sanitizeIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  try {
    const parsed = new URL(icon);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? icon : undefined;
  } catch {
    return undefined;
  }
}

export interface AssetInfo {
  assetId: string;
  amount: number;
  displayAmount: number;
  genesisTxid: string;
  metadata?: { name?: string; ticker?: string; decimals?: number; icon?: string };
}

export class AssetService {
  // Works for assets no longer held, since it queries by id.
  async getAssetMetadata(wallet: IWallet, assetId: string): Promise<AssetInfo['metadata']> {
    try {
      const details = await wallet.assetManager.getAssetDetails(assetId);
      return details.metadata
        ? {
            name: details.metadata.name,
            ticker: details.metadata.ticker,
            decimals: details.metadata.decimals,
            icon: sanitizeIconUrl(details.metadata.icon),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  // SDK balances are bigint; returned as number to match the dApp-facing API.
  async getAssets(wallet: IWallet): Promise<AssetInfo[]> {
    const { assets } = await wallet.getBalance();
    return Promise.all(
      assets.map(async (asset) => {
        const metadata = await this.getAssetMetadata(wallet, asset.assetId);
        const decimals = metadata?.decimals ?? 0;
        const amount = Number(asset.amount);
        return {
          assetId: asset.assetId,
          amount,
          displayAmount: amount / 10 ** decimals,
          genesisTxid: genesisTxidFromAssetId(asset.assetId),
          metadata,
        };
      }),
    );
  }

  async getTransactionHistory(wallet: IWallet, assetId: string, lightningTxids: Set<string>): Promise<TxHistoryEntry[]> {
    const txs = await wallet.getTransactionHistory();
    return txs
      .filter((tx) => tx.assets?.some((a) => a.assetId === assetId))
      .map((tx) => toHistoryEntry(tx, lightningTxids));
  }
}
