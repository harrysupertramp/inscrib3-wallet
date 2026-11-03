import type { WalletClient, WalletClientEvent } from '@inscrib3/core';
import { sendToBackground } from '../messaging/popup-client.js';
import { isInternalSender } from '../messaging/protocol.js';

export function createExtensionWalletClient(): WalletClient {
  return {
    generateMnemonic: () => sendToBackground('wallet_generateMnemonic'),
    create: (mnemonic, password) => sendToBackground('wallet_create', { mnemonic, password }),
    restore: (mnemonic, password) => sendToBackground('wallet_restore', { mnemonic, password }),
    unlock: (password) => sendToBackground('wallet_unlock', { password }),
    lock: () => sendToBackground('wallet_lock'),
    isCreated: () => sendToBackground('wallet_isCreated'),
    isUnlocked: () => sendToBackground('wallet_isUnlocked'),

    getAddress: () => sendToBackground('wallet_getAddress'),
    getBoardingAddress: () => sendToBackground('wallet_getBoardingAddress'),
    getExitFeeAddress: () => sendToBackground('wallet_getExitFeeAddress'),
    getBalance: () => sendToBackground('wallet_getBalance'),
    getVtxos: () => sendToBackground('wallet_getVtxos'),
    getAssets: () => sendToBackground('wallet_getAssets'),
    getAssetMetadata: (assetId) => sendToBackground('wallet_getAssetMetadata', { assetId }),
    getTransactionHistory: () => sendToBackground('wallet_getTransactionHistory'),
    getAssetTransactionHistory: (assetId) => sendToBackground('wallet_getAssetTransactionHistory', { assetId }),

    send: (address, amount, selectedVtxos) => sendToBackground('wallet_send', { address, amount, selectedVtxos }),
    quoteOnchainSend: (address, amount) => sendToBackground('wallet_quoteOnchainSend', { address, amount }),
    sendOnchain: (address, amount) => sendToBackground('wallet_sendOnchain', { address, amount }),
    sendAsset: (address, assets, bitcoinAmount, selectedVtxos) =>
      sendToBackground('wallet_sendAsset', { address, assets, bitcoinAmount, selectedVtxos }),
    settle: () => sendToBackground('wallet_settle'),
    isSettling: () => sendToBackground('wallet_isSettling'),
    getSettleProgress: () => sendToBackground('wallet_getSettleProgress'),

    getSpendableVtxos: () => sendToBackground('wallet_getSpendableVtxos'),
    resetLocalCache: (password) => sendToBackground('wallet_resetLocalCache', { password }),


    signMessage: (message) => sendToBackground('wallet_signMessage', { message }),
    exportMnemonic: (password) => sendToBackground('wallet_exportMnemonic', { password }),
    getNetworkSettings: () => sendToBackground('wallet_getNetworkSettings'),
    getConnectionInfo: () => sendToBackground('wallet_getConnectionInfo'),
    setNetworkSettings: (settings) => sendToBackground('wallet_setNetworkSettings', settings),

    listAccounts: () => sendToBackground('wallet_listAccounts'),
    getActiveAccount: () => sendToBackground('wallet_getActiveAccount'),
    addAccount: (label) => sendToBackground('wallet_addAccount', { label }),
    importSeed: (mnemonic, label) => sendToBackground('wallet_importSeed', { mnemonic, label }),
    switchAccount: (seedId, accountIndex) => sendToBackground('wallet_switchAccount', { seedId, accountIndex }),
    renameAccount: (seedId, accountIndex, label) => sendToBackground('wallet_renameAccount', { seedId, accountIndex, label }),
    removeAccount: (seedId, accountIndex) => sendToBackground('wallet_removeAccount', { seedId, accountIndex }),
    resetToPrimaryAccount: () => sendToBackground('wallet_resetToPrimaryAccount'),

    isLightningAvailable: () => sendToBackground('wallet_isLightningAvailable'),
    createLightningInvoice: (amountSats) => sendToBackground('wallet_createLightningInvoice', { amount: amountSats }),
    getLightningInvoiceStatus: (swapId) => sendToBackground('wallet_getLightningInvoiceStatus', { swapId }),
    prepareLightningPayment: (invoice) => sendToBackground('wallet_prepareLightningPayment', { invoice }),
    confirmLightningPayment: (quoteId) => sendToBackground('wallet_confirmLightningPayment', { quoteId }),

    estimateExit: (sweepAddress) => sendToBackground('wallet_estimateExit', { sweepAddress }),
    startExit: (sweepAddress) => sendToBackground('wallet_startExit', { sweepAddress }),
    hasPendingExit: () => sendToBackground('wallet_hasPendingExit'),
    getExitProgress: () => sendToBackground('wallet_getExitProgress'),

    getConnectedOrigins: () => sendToBackground('wallet_getConnectedOrigins'),
    revokeOrigin: (origin) => sendToBackground('wallet_revokeOrigin', { origin }),

    onEvent(callback) {
      // Content scripts can message this window too, carrying whatever a page
      // wrote, so only events from the extension itself count.
      function listener(message: unknown, sender: Browser.runtime.MessageSender) {
        if (!isInternalSender(sender)) return;
        if (!message || typeof message !== 'object' || !('_arkadeEvent' in message)) return;
        const event = (message as { event?: string }).event;
        if (
          event === 'lock' ||
          event === 'unlock' ||
          event === 'networkChanged' ||
          event === 'accountChanged' ||
          event === 'fundsReceived'
        ) {
          callback(event as WalletClientEvent, (message as { data?: unknown }).data);
        }
      }
      browser.runtime.onMessage.addListener(listener);
      return () => browser.runtime.onMessage.removeListener(listener);
    },
  };
}
