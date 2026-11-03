import type { WalletStorage } from '@satora/swap';
import type { KeyValueStore } from './key-value-store.js';
import type { EncryptedPayload, PasswordCipher } from './session.js';

function mnemonicKey(scope: string): string {
  return scope ? `arkade:satora:signer:encrypted:${scope}` : 'arkade:satora:signer:encrypted';
}

function keyIndexKey(scope: string): string {
  return scope ? `arkade:satora:signer:key-index:${scope}` : 'arkade:satora:signer:key-index';
}

// Satora gets its own signer, unrelated to the wallet mnemonic, so a bug in
// the swap SDK can't reach wallet funds. It still signs refunds, so it is
// encrypted with the wallet password.
export class SatoraSignerStorage implements WalletStorage {
  constructor(
    private readonly store: KeyValueStore,
    private readonly cipher: PasswordCipher,
    private readonly scope: string,
  ) {}

  async getMnemonic(): Promise<string | null> {
    const payload = await this.store.get<EncryptedPayload>(mnemonicKey(this.scope));
    if (!payload) return null;
    return this.cipher.decrypt(payload);
  }

  async setMnemonic(mnemonic: string): Promise<void> {
    const payload = await this.cipher.encrypt(mnemonic);
    await this.store.set(mnemonicKey(this.scope), payload);
  }

  async getKeyIndex(): Promise<number> {
    return (await this.store.get<number>(keyIndexKey(this.scope))) ?? 0;
  }

  async setKeyIndex(index: number): Promise<void> {
    await this.store.set(keyIndexKey(this.scope), index);
  }

  async incrementKeyIndex(): Promise<number> {
    const current = await this.getKeyIndex();
    await this.setKeyIndex(current + 1);
    return current;
  }

  async clear(): Promise<void> {
    // KeyValueStore has no delete; null reads back as absent.
    await this.store.set(mnemonicKey(this.scope), null);
    await this.store.set(keyIndexKey(this.scope), null);
  }
}
