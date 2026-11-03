import {
  WalletManager,
  loadNetworkSettings,
  saveNetworkSettings,
  describeNetwork,
  fetchConnectionInfo,
  type WalletClient,
  type WalletClientEvent,
  type NetworkSettings,
} from '@inscrib3/core';
import { createPwaKeyValueStore } from './pwa-kv-store.js';

// Holds WalletManager in the page itself; there is no background process.
export function createPwaWalletClient(): WalletClient {
  const store = createPwaKeyValueStore();
  const manager = new WalletManager(store);
  const listeners = new Set<(event: WalletClientEvent, data?: unknown) => void>();

  function emit(event: WalletClientEvent, data?: unknown): void {
    for (const cb of listeners) cb(event, data);
  }

  manager.onIncomingFunds((funds) => emit('fundsReceived', funds));

  return {
    generateMnemonic: async () => manager.generateMnemonic(),
    async create(mnemonic, password) {
      await manager.create(mnemonic, password);
      emit('unlock');
    },
    async restore(mnemonic, password) {
      await manager.restore(mnemonic, password);
      emit('unlock');
    },
    async unlock(password) {
      await manager.unlock(password);
      emit('unlock');
    },
    async lock() {
      await manager.lock();
      emit('lock');
    },
    isCreated: () => manager.isCreated(),
    isUnlocked: async () => manager.isUnlocked(),

    getAddress: () => manager.getAddress(),
    getBoardingAddress: () => manager.getBoardingAddress(),
    getExitFeeAddress: () => manager.getExitFeeAddress(),
    getBalance: () => manager.getBalance(),
    getVtxos: () => manager.getVtxos(),
    getAssets: () => manager.getAssets(),
    getAssetMetadata: (assetId) => manager.getAssetMetadata(assetId),
    getTransactionHistory: () => manager.getTransactionHistory(),
    getAssetTransactionHistory: (assetId) => manager.getAssetTransactionHistory(assetId),

    send: (address, amount, selectedVtxos) => manager.send(address, amount, selectedVtxos),
    quoteOnchainSend: (address, amount) => manager.quoteOnchainSend(address, amount),
    sendOnchain: (address, amount) => manager.sendOnchain(address, amount),
    sendAsset: (address, assets, bitcoinAmount, selectedVtxos) =>
      manager.sendAsset(address, assets, bitcoinAmount, selectedVtxos),
    settle: () => manager.settle(),
    isSettling: async () => manager.isSettling(),
    getSettleProgress: () => manager.getSettleProgress(),

    getSpendableVtxos: () => manager.getSpendableVtxos(),
    resetLocalCache: (password) => manager.resetLocalCache(password),


    signMessage: (message) => manager.signMessage(message),
    exportMnemonic: (password) => manager.exportMnemonic(password),
    getNetworkSettings: () => loadNetworkSettings(store),
    getConnectionInfo: async () => fetchConnectionInfo(await loadNetworkSettings(store)),
    async setNetworkSettings(settings: NetworkSettings) {
      await saveNetworkSettings(store, settings);
      const network = describeNetwork(settings).network;
      // Reconnects with the cached password instead of forcing a re-unlock.
      if (manager.isUnlocked()) {
        try {
          await manager.reconnect();
        } catch (e: unknown) {
          emit('lock');
          emit('networkChanged', network);
          throw new Error(`Saved, but the new server couldn't be reached - unlock to try again. ${String(e)}`);
        }
      }
      emit('networkChanged', network);
    },

    listAccounts: () => manager.listAccounts(),
    getActiveAccount: () => manager.getActiveAccount(),
    async addAccount(label) {
      const info = await manager.addAccount(label);
      emit('accountChanged');
      return info;
    },
    async importSeed(mnemonic, label) {
      const info = await manager.importSeed(mnemonic, label);
      emit('accountChanged');
      return info;
    },
    async switchAccount(seedId, accountIndex) {
      await manager.switchAccount(seedId, accountIndex);
      emit('accountChanged');
    },
    renameAccount: (seedId, accountIndex, label) => manager.renameAccount(seedId, accountIndex, label),
    removeAccount: (seedId, accountIndex) => manager.removeAccount(seedId, accountIndex),
    resetToPrimaryAccount: () => manager.resetToPrimaryAccount(),

    isLightningAvailable: async () => manager.isLightningAvailable(),
    createLightningInvoice: (amountSats) => manager.createLightningInvoice(amountSats),
    getLightningInvoiceStatus: (swapId) => manager.getLightningInvoiceStatus(swapId),
    prepareLightningPayment: (invoice) => manager.prepareLightningPayment(invoice),
    confirmLightningPayment: (quoteId) => manager.confirmLightningPayment(quoteId),

    estimateExit: (sweepAddress) => manager.estimateExit(sweepAddress),
    startExit: (sweepAddress) => manager.startExit(sweepAddress),
    hasPendingExit: () => manager.hasPendingExit(),
    getExitProgress: () => manager.getExitProgress(),

    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
