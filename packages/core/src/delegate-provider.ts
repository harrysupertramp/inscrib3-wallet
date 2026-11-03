import { RestDelegateProvider } from '@arkade-os/sdk';
import type { DelegateInfo, DelegateProvider } from '@arkade-os/sdk';
import type { KeyValueStore } from './key-value-store.js';

const DELEGATE_INFO_STORAGE_KEY = 'arkade:delegate:info';

interface CachedDelegateInfo {
  url: string;
  info: DelegateInfo;
}

// Caches the delegate pubkey so a delegation-service outage can't change the
// derived address: Wallet.create silently falls back to the 2-leaf script on
// failure, hiding the 3-leaf address's balance. Live data always wins; a stale
// key during an outage is safe because the delegate leaf needs our signature.
export function createCachingDelegateProvider(
  url: string,
  store: KeyValueStore,
): DelegateProvider {
  return withDelegateInfoCache(new RestDelegateProvider(url), url, store);
}

export function withDelegateInfoCache(
  live: DelegateProvider,
  url: string,
  store: KeyValueStore,
): DelegateProvider {
  return {
    async getDelegateInfo(): Promise<DelegateInfo> {
      try {
        const info = await live.getDelegateInfo();
        await store.set(DELEGATE_INFO_STORAGE_KEY, { url, info } satisfies CachedDelegateInfo);
        return info;
      } catch (e) {
        const cached = await store.get<CachedDelegateInfo>(DELEGATE_INFO_STORAGE_KEY);
        // Keyed by URL so a different delegator's pubkey is never used.
        if (!cached || cached.url !== url) throw e;
        return cached.info;
      }
    },
    // Not cached: delegating is a live operation, and the SDK treats failure as non-fatal.
    delegate: (intent, forfeitTxs, options) => live.delegate(intent, forfeitTxs, options),
  };
}
