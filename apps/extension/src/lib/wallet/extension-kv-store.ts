import type { KeyValueStore } from '@inscrib3/core';

export function createExtensionKeyValueStore(): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await browser.storage.local.get(key);
      return result[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await browser.storage.local.set({ [key]: value });
    },
  };
}
