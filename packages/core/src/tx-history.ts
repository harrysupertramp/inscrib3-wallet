import { TxType, type IWallet } from '@arkade-os/sdk';

export interface TxHistoryEntry {
  txid: string;
  type: 'send' | 'receive';
  amount: number;
  status: 'confirmed' | 'pending';
  timestamp: number;
  // 'lightning' comes from LightningService's known-txid set.
  layer: 'ark' | 'onchain' | 'lightning';
  // L1 txid when there is one (commitment or boarding tx); `txid` is often an
  // offchain Ark txid that no Bitcoin explorer knows.
  onchainTxid?: string;
  // Raw units, no decimals applied.
  assets?: { assetId: string; amount: number; isMint?: boolean }[];
}

type ArkTransaction = Awaited<ReturnType<IWallet['getTransactionHistory']>>[number];

// The SDK types an asset's genesis tx as "sent"; for the issuer it is a mint,
// so its amount should read as gained.
function isAssetGenesis(assetId: string, txid: string): boolean {
  return assetId.slice(0, 64) === txid;
}

export function toHistoryEntry(tx: ArkTransaction, lightningTxids: Set<string>): TxHistoryEntry {
  const txid = tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid || '';
  const onchainTxid = tx.key.commitmentTxid || tx.key.boardingTxid || undefined;
  const assets = tx.assets?.map((a) => ({
    assetId: a.assetId,
    amount: Number(a.amount),
    ...(isAssetGenesis(a.assetId, txid) ? { isMint: true } : {}),
  }));
  return {
    txid,
    type: tx.type === TxType.TxSent ? 'send' : 'receive',
    amount: tx.amount,
    status: tx.settled ? 'confirmed' : 'pending',
    timestamp: Math.floor(tx.createdAt / 1000),
    layer: lightningTxids.has(txid) ? 'lightning' : tx.key.boardingTxid ? 'onchain' : 'ark',
    ...(onchainTxid ? { onchainTxid } : {}),
    ...(assets && assets.length > 0 ? { assets } : {}),
  };
}
