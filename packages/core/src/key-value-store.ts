// Platform storage behind WalletManager: browser.storage.local in the
// extension, localStorage in the PWA.
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}
