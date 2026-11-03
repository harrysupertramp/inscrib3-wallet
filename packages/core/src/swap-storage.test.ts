import { describe, expect, test, spyOn } from 'bun:test';
import type { RfqSwapRecord } from '@arkade-os/swap/protocol';
import type { StoredSwap, GetSwapResponse } from '@satora/swap';
import { inMemoryStore } from './test-helpers.js';
import { PasswordCipher, encryptMnemonic, decryptMnemonic } from './session.js';
import { KeyValueSatoraSwapStorage } from './satora-swap-storage.js';
import { SatoraSignerStorage } from './satora-signer-storage.js';
import { KeyValueRfqSwapStore } from './rfq-swap-store.js';

const swap = (swapId: string) => ({ swapId, response: { id: swapId } }) as unknown as StoredSwap;
const rfq = (rfqId: string) => ({ rfqId }) as unknown as RfqSwapRecord;

describe('PasswordCipher', () => {
  test('round-trips, and reads payloads written by encryptMnemonic', async () => {
    const cipher = new PasswordCipher('pw');
    expect(await cipher.decrypt(await cipher.encrypt('hello'))).toBe('hello');
    expect(await cipher.decrypt(await encryptMnemonic('legacy', 'pw'))).toBe('legacy');
    expect(await decryptMnemonic(await cipher.encrypt('both ways'), 'pw')).toBe('both ways');
  });

  test('derives the key once for repeated writes, with a fresh IV each time', async () => {
    const derive = spyOn(crypto.subtle, 'deriveKey');
    const cipher = new PasswordCipher('pw');
    const a = await cipher.encrypt('x');
    const b = await cipher.encrypt('x');
    await cipher.decrypt(a);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(a.iv).not.toBe(b.iv);
    derive.mockRestore();
  });

  test('rejects the wrong password', async () => {
    const payload = await new PasswordCipher('right').encrypt('secret');
    await expect(new PasswordCipher('wrong').decrypt(payload)).rejects.toThrow();
  });
});

describe('KeyValueSatoraSwapStorage', () => {
  test('concurrent stores all persist', async () => {
    const storage = new KeyValueSatoraSwapStorage(inMemoryStore(), 'bitcoin', new PasswordCipher('pw'), '');
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => storage.store(swap(id))));
    expect((await storage.list()).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('update, delete and clear', async () => {
    const storage = new KeyValueSatoraSwapStorage(inMemoryStore(), 'bitcoin', new PasswordCipher('pw'), '');
    await storage.store(swap('a'));
    await storage.store(swap('b'));
    await storage.update('a', { id: 'a', status: 'clientredeemed' } as unknown as GetSwapResponse);
    expect((await storage.get('a'))?.response).toMatchObject({ status: 'clientredeemed' });
    await expect(storage.update('missing', {} as GetSwapResponse)).rejects.toThrow(/no stored Satora swap/);
    await storage.delete('b');
    expect(await storage.list()).toEqual(['a']);
    await storage.clear();
    expect(await storage.list()).toEqual([]);
  });

  test('stores ciphertext only, readable by a fresh cipher after a restart', async () => {
    const kv = inMemoryStore();
    await new KeyValueSatoraSwapStorage(kv, 'bitcoin', new PasswordCipher('pw'), '').store(swap('a'));
    expect(JSON.stringify(await kv.get('arkade:satora:swaps:bitcoin'))).not.toContain('"swapId"');
    const reopened = new KeyValueSatoraSwapStorage(kv, 'bitcoin', new PasswordCipher('pw'), '');
    expect(await reopened.list()).toEqual(['a']);
  });
});

describe('SatoraSignerStorage', () => {
  test('encrypts the mnemonic and tracks the key index', async () => {
    const kv = inMemoryStore();
    const storage = new SatoraSignerStorage(kv, new PasswordCipher('pw'), '1-0');
    expect(await storage.getMnemonic()).toBeNull();
    await storage.setMnemonic('signer words');
    expect(JSON.stringify(await kv.get('arkade:satora:signer:encrypted:1-0'))).not.toContain('signer words');
    expect(await storage.getMnemonic()).toBe('signer words');
    expect(await storage.incrementKeyIndex()).toBe(0);
    expect(await storage.incrementKeyIndex()).toBe(1);
    await storage.clear();
    expect(await storage.getMnemonic()).toBeNull();
    expect(await storage.getKeyIndex()).toBe(0);
  });
});

describe('KeyValueRfqSwapStore', () => {
  test('concurrent saves all persist; save replaces by id; remove deletes', async () => {
    const store = new KeyValueRfqSwapStore(inMemoryStore(), 'bitcoin', '');
    await Promise.all(['a', 'b', 'c'].map((id) => store.saveRfqSwap(rfq(id))));
    await store.saveRfqSwap({ ...rfq('a'), state: 'settled' } as unknown as RfqSwapRecord);
    expect((await store.getAllRfqSwaps()).map((r) => r.rfqId).sort()).toEqual(['a', 'b', 'c']);
    expect(await store.getRfqSwap('a')).toMatchObject({ state: 'settled' });
    await store.removeRfqSwap('b');
    expect((await store.getAllRfqSwaps()).map((r) => r.rfqId).sort()).toEqual(['a', 'c']);
  });

  // The SDK reads in-flight swaps through these pages on restore, so a page
  // that skipped or repeated a swap would lose or double-drive it.
  test('pages by (updatedAt, rfqId) with each swap exactly once, filtered by state and since', async () => {
    const store = new KeyValueRfqSwapStore(inMemoryStore(), 'bitcoin', '');
    const at = (rfqId: string, updatedAt: number, state = 'pending') => ({ rfqId, updatedAt, state }) as unknown as RfqSwapRecord;
    for (const r of [at('c', 20), at('a', 10), at('b', 20, 'settled'), at('d', 30)]) await store.saveRfqSwap(r);

    const first = await store.getRfqSwapsPage({}, { limit: 2 });
    expect(first.items.map((r) => r.rfqId)).toEqual(['a', 'b']);
    const second = await store.getRfqSwapsPage({}, { limit: 2, after: first.nextCursor });
    expect(second.items.map((r) => r.rfqId)).toEqual(['c', 'd']);
    expect(second.nextCursor).toBeUndefined();

    expect((await store.getRfqSwapsPage({ state: 'pending', since: 20 }, { limit: 10 })).items.map((r) => r.rfqId)).toEqual(['c', 'd']);
  });
});
