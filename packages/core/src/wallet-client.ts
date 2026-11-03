import type {
  SerializableWalletBalance,
  TxHistoryEntry,
  SerializableVtxo,
  SerializableExitProgress,
  SerializableSettleProgress,
  VtxoOutpoint,
  SignedMessage,
  LightningPaymentQuote,
  OnchainSendQuote,
} from './wallet-manager.js';
import type { NetworkSettings } from './network-settings.js';
import type { ConnectionInfo } from './connection-info.js';
import type { AccountInfo, ActiveAccount } from './accounts.js';
import type { ExitQuote } from '@arkade-os/sdk';

export type { VtxoOutpoint } from './wallet-manager.js';
export type { AccountInfo, ActiveAccount } from './accounts.js';

export interface AssetEntry {
  assetId: string;
  amount: number;
  displayAmount: number;
  genesisTxid: string;
  metadata?: { name?: string; ticker?: string; decimals?: number; icon?: string };
}

// 'accountChanged' has no payload, so unlike the dApp-facing 'accountsChanged'
// it needs no per-origin scoping.
export type WalletClientEvent =
  | 'lock'
  | 'unlock'
  | 'networkChanged'
  | 'accountChanged'
  // payload: IncomingFundsSummary
  | 'fundsReceived';

// Everything the UI needs from the wallet. The extension implements it by
// messaging the background worker; the PWA calls WalletManager directly.
export interface WalletClient {
  generateMnemonic(): Promise<string>;
  create(mnemonic: string, password: string): Promise<void>;
  restore(mnemonic: string, password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  isCreated(): Promise<boolean>;
  isUnlocked(): Promise<boolean>;

  getAddress(): Promise<string>;
  getBoardingAddress(): Promise<string>;
  getExitFeeAddress(): Promise<string>;
  getBalance(): Promise<SerializableWalletBalance>;
  getVtxos(): Promise<SerializableVtxo[]>;
  getAssets(): Promise<AssetEntry[]>;
  getAssetMetadata(assetId: string): Promise<AssetEntry['metadata']>;
  getTransactionHistory(): Promise<TxHistoryEntry[]>;
  getAssetTransactionHistory(assetId: string): Promise<TxHistoryEntry[]>;

  send(address: string, amount: number, selectedVtxos?: VtxoOutpoint[]): Promise<string>;
  // Exit fee for an Ark exit of `amount`; it is added on top of the amount.
  quoteOnchainSend(address: string, amount: number): Promise<OnchainSendQuote>;
  sendOnchain(address: string, amount?: number): Promise<string>;
  sendAsset(
    address: string,
    assets: Array<{ assetId: string; amount: number }>,
    bitcoinAmount?: number,
    selectedVtxos?: VtxoOutpoint[],
  ): Promise<string>;
  settle(): Promise<string>;
  // Lets the popup show progress for, or detect, a settle already running.
  isSettling(): Promise<boolean>;
  getSettleProgress(): Promise<SerializableSettleProgress>;

  getSpendableVtxos?(): Promise<SerializableVtxo[]>;

  // Wipes the local VTXO/tx cache and resyncs; never touches the seed.
  resetLocalCache?(password: string): Promise<void>;

  signMessage?(message: string): Promise<SignedMessage>;

  exportMnemonic(password: string): Promise<string>;
  getNetworkSettings(): Promise<NetworkSettings>;
  setNetworkSettings(settings: NetworkSettings): Promise<void>;
  getConnectionInfo?(): Promise<ConnectionInfo>;

  // add/switch/import need no password: it is cached while unlocked.
  listAccounts(): Promise<AccountInfo[]>;
  getActiveAccount(): Promise<ActiveAccount>;
  addAccount(label?: string): Promise<AccountInfo>;
  importSeed(mnemonic: string, label?: string): Promise<AccountInfo>;
  switchAccount(seedId: number, accountIndex: number): Promise<void>;
  renameAccount(seedId: number, accountIndex: number, label: string): Promise<void>;
  // Hides the account from the list only. Rejects the active or last account.
  removeAccount(seedId: number, accountIndex: number): Promise<void>;
  // Points unlock() back at seed 0 / account 0; works while locked.
  resetToPrimaryAccount(): Promise<void>;

  isLightningAvailable(): Promise<boolean>;
  createLightningInvoice(amountSats: number): Promise<{ invoice: string; swapId: string; expiresAt: number }>;
  getLightningInvoiceStatus(swapId: string): Promise<{ status: string; completed: boolean; failed: boolean }>;
  // Quote first (no funds move) so the full cost can be shown, then confirm.
  prepareLightningPayment(invoice: string): Promise<LightningPaymentQuote>;
  confirmLightningPayment(quoteId: string): Promise<{ amount: number; preimage: string; txid: string }>;

  // Unilateral exit; getExitProgress() runs for a bounded time per call.
  estimateExit(sweepAddress: string): Promise<ExitQuote>;
  startExit(sweepAddress: string): Promise<void>;
  hasPendingExit(): Promise<boolean>;
  getExitProgress(): Promise<SerializableExitProgress>;

  onEvent(callback: (event: WalletClientEvent, data?: unknown) => void): () => void;

  // Extension only: per-origin dApp permissions.
  getConnectedOrigins?(): Promise<string[]>;
  revokeOrigin?(origin: string): Promise<void>;
}
