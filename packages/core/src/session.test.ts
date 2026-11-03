import { describe, expect, test } from 'bun:test';
import { encryptMnemonic, decryptMnemonic, hasStoredWallet, saveEncryptedMnemonic, loadEncryptedMnemonic } from './session.js';
import { inMemoryStore } from './test-helpers.js';

describe('encryptMnemonic / decryptMnemonic', () => {
  test('round-trips a mnemonic through the same password', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const payload = await encryptMnemonic(mnemonic, 'correct-password');
    const decrypted = await decryptMnemonic(payload, 'correct-password');
    expect(decrypted).toBe(mnemonic);
  });

  test('the wrong password fails to decrypt (tamper/wrong-password detection)', async () => {
    const payload = await encryptMnemonic('some mnemonic words here', 'right-password');
    await expect(decryptMnemonic(payload, 'wrong-password')).rejects.toThrow();
  });

  test('salt and iv are different on every call (never reused)', async () => {
    const a = await encryptMnemonic('same mnemonic', 'same-password');
    const b = await encryptMnemonic('same mnemonic', 'same-password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe('hasStoredWallet / saveEncryptedMnemonic / loadEncryptedMnemonic', () => {
  test('reports false when nothing has been saved', async () => {
    expect(await hasStoredWallet(inMemoryStore())).toBe(false);
  });

  test('reports true and round-trips after saving', async () => {
    const store = inMemoryStore();
    const payload = await encryptMnemonic('test mnemonic', 'pw');
    await saveEncryptedMnemonic(store, payload);
    expect(await hasStoredWallet(store)).toBe(true);
    const loaded = await loadEncryptedMnemonic(store);
    expect(loaded).toEqual(payload);
  });

  test('corrupted stored data throws a distinguishable WALLET_DATA_CORRUPTED error, not a raw parse error', async () => {
    const store = inMemoryStore();
    await store.set('arkade:wallet:encrypted', 'not valid json{{{');
    await expect(loadEncryptedMnemonic(store)).rejects.toThrow('WALLET_DATA_CORRUPTED');
  });

  // Real mainnet funds already depend on seed 0's exact unsuffixed key -
  // a regression here would silently orphan an existing user's wallet.
  test('seedId 0 (default, omitted) reads/writes the exact key existing installs already use', async () => {
    const store = inMemoryStore();
    const payload = await encryptMnemonic('test mnemonic', 'pw');
    await saveEncryptedMnemonic(store, payload);
    expect(await store.get('arkade:wallet:encrypted')).toBeDefined();
  });

  test('a second imported seed is stored under its own key, independent of seed 0', async () => {
    const store = inMemoryStore();
    const seed0 = await encryptMnemonic('seed zero mnemonic', 'pw');
    const seed1 = await encryptMnemonic('seed one mnemonic', 'pw');
    await saveEncryptedMnemonic(store, seed0, 0);
    await saveEncryptedMnemonic(store, seed1, 1);
    expect(await loadEncryptedMnemonic(store, 0)).toEqual(seed0);
    expect(await loadEncryptedMnemonic(store, 1)).toEqual(seed1);
  });

  test('hasStoredWallet only ever checks seed 0, regardless of other imported seeds', async () => {
    const store = inMemoryStore();
    await saveEncryptedMnemonic(store, await encryptMnemonic('only an imported seed', 'pw'), 1);
    expect(await hasStoredWallet(store)).toBe(false);
  });
});
