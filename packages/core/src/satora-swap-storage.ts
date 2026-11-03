import type { GetSwapResponse, StoredSwap, SwapStorage } from '@satora/swap';
import type { KeyValueStore } from './key-value-store.js';
import type { EncryptedPayload, PasswordCipher } from './session.js';
import { Mutex } from './mutex.js';

function storageKey(network: string, scope: string): string {
  const base = `arkade:satora:swaps:${network}`;
  return scope ? `${base}:${scope}` : base;
}

// Stored swaps hold secrets (refund key, preimage), so the whole list is
// encrypted with the wallet password. Writes are serialized: the SDK's tracker
// updates swaps while new ones are being stored.
export class KeyValueSatoraSwapStorage implements SwapStorage {
  private readonly writes = new Mutex();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly network: string,
    private readonly cipher: PasswordCipher,
    private readonly scope: string,
  ) {}

  async getAll(): Promise<StoredSwap[]> {
    const payload = await this.kv.get<EncryptedPayload>(storageKey(this.network, this.scope));
    if (!payload) return [];
    const plaintext = await this.cipher.decrypt(payload);
    return JSON.parse(plaintext) as StoredSwap[];
  }

  async list(): Promise<string[]> {
    return (await this.getAll()).map((s) => s.swapId);
  }

  async get(swapId: string): Promise<StoredSwap | null> {
    const all = await this.getAll();
    return all.find((s) => s.swapId === swapId) ?? null;
  }

  store(swap: StoredSwap): Promise<void> {
    return this.writes.run(async () => {
      const all = await this.getAll();
      const at = all.findIndex((s) => s.swapId === swap.swapId);
      if (at === -1) all.push(swap);
      else all[at] = swap;
      await this.save(all);
    });
  }

  update(swapId: string, response: GetSwapResponse): Promise<void> {
    return this.writes.run(async () => {
      const all = await this.getAll();
      const at = all.findIndex((s) => s.swapId === swapId);
      if (at === -1) throw new Error(`no stored Satora swap ${swapId} to update`);
      all[at] = { ...all[at], response };
      await this.save(all);
    });
  }

  delete(swapId: string): Promise<void> {
    return this.writes.run(async () => {
      const all = await this.getAll();
      await this.save(all.filter((s) => s.swapId !== swapId));
    });
  }

  clear(): Promise<void> {
    return this.writes.run(() => this.save([]));
  }

  private async save(all: StoredSwap[]): Promise<void> {
    const payload = await this.cipher.encrypt(JSON.stringify(all));
    await this.kv.set(storageKey(this.network, this.scope), payload);
  }
}
