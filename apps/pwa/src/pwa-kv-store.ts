import type { KeyValueStore } from '@inscrib3/core';

export function createPwaKeyValueStore(): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = localStorage.getItem(key);
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
}
