import { inject, type InjectionKey } from 'vue';
import type { WalletClient } from '@inscrib3/core';

export const WALLET_CLIENT_KEY: InjectionKey<WalletClient> = Symbol('walletClient');

// Components only reach the wallet through this, so the same UI runs in the
// extension popup and the PWA.
export function useWalletClient(): WalletClient {
  const client = inject(WALLET_CLIENT_KEY);
  if (!client) {
    throw new Error('WalletClient not provided — call app.provide(WALLET_CLIENT_KEY, ...) before mounting');
  }
  return client;
}
