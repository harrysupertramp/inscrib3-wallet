import {
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
  IndexedDBIntentRepository,
  type StorageConfig,
} from '@arkade-os/sdk';

// Suffixed by network and account scope: the SDK keeps one wallet-state
// record per database, which must not be shared across networks or accounts.
export function dbNameFor(prefix: 'wallet' | 'contracts' | 'intents', network: string, scope: string): string {
  const base = `arkade-${prefix}-${network}`;
  return scope ? `${base}-${scope}` : base;
}

export function createStorageConfig(network: string, scope: string): StorageConfig {
  return {
    walletRepository: new IndexedDBWalletRepository(dbNameFor('wallet', network, scope)),
    contractRepository: new IndexedDBContractRepository(dbNameFor('contracts', network, scope)),
    intentRepository: new IndexedDBIntentRepository(dbNameFor('intents', network, scope)),
  };
}
