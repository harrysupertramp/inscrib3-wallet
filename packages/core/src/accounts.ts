import type { KeyValueStore } from './key-value-store.js';

const ACCOUNTS_LIST_KEY = 'arkade:accounts:list';
const ACTIVE_ACCOUNT_KEY = 'arkade:accounts:active';

// seedId: which imported seed phrase (0 = the original). index: HD account
// index within that seed.
export interface AccountInfo {
  seedId: number;
  index: number;
  label: string;
  // Added by WalletManager.listAccounts while unlocked, since the coin type
  // depends on the network. Never stored.
  derivationPath?: string;
}

export interface ActiveAccount {
  seedId: number;
  index: number;
}

const DEFAULT_ACCOUNTS: AccountInfo[] = [{ seedId: 0, index: 0, label: 'Account 1' }];
const DEFAULT_ACTIVE: ActiveAccount = { seedId: 0, index: 0 };

export async function loadAccounts(store: KeyValueStore): Promise<AccountInfo[]> {
  const stored = await store.get<AccountInfo[]>(ACCOUNTS_LIST_KEY);
  return stored && stored.length > 0 ? stored : DEFAULT_ACCOUNTS;
}

export async function saveAccounts(store: KeyValueStore, accounts: AccountInfo[]): Promise<void> {
  await store.set(ACCOUNTS_LIST_KEY, accounts);
}

export async function loadActiveAccount(store: KeyValueStore): Promise<ActiveAccount> {
  return (await store.get<ActiveAccount>(ACTIVE_ACCOUNT_KEY)) ?? DEFAULT_ACTIVE;
}

export async function saveActiveAccount(store: KeyValueStore, active: ActiveAccount): Promise<void> {
  await store.set(ACTIVE_ACCOUNT_KEY, active);
}

// Suffix for every per-account storage key. Seed 0 / account 0 gets none so
// wallets created before multi-account support keep their existing keys.
export function accountScopeKey(seedId: number, index: number): string {
  return seedId === 0 && index === 0 ? '' : `${seedId}-${index}`;
}
