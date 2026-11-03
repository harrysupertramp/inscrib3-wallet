import { describe, expect, test } from 'bun:test';
import { loadAccounts, saveAccounts, loadActiveAccount, saveActiveAccount, accountScopeKey } from './accounts.js';
import { inMemoryStore } from './test-helpers.js';

describe('loadAccounts', () => {
  test('defaults to a single "Account 1" at seed 0 / index 0 when nothing has been saved', async () => {
    const accounts = await loadAccounts(inMemoryStore());
    expect(accounts).toEqual([{ seedId: 0, index: 0, label: 'Account 1' }]);
  });

  test('returns whatever was previously saved', async () => {
    const store = inMemoryStore();
    const saved = [
      { seedId: 0, index: 0, label: 'Main' },
      { seedId: 0, index: 1, label: 'Savings' },
      { seedId: 1, index: 0, label: 'Imported' },
    ];
    await saveAccounts(store, saved);
    expect(await loadAccounts(store)).toEqual(saved);
  });
});

describe('loadActiveAccount', () => {
  test('defaults to seed 0 / index 0 when nothing has been saved', async () => {
    expect(await loadActiveAccount(inMemoryStore())).toEqual({ seedId: 0, index: 0 });
  });

  test('returns whatever was previously saved', async () => {
    const store = inMemoryStore();
    await saveActiveAccount(store, { seedId: 1, index: 2 });
    expect(await loadActiveAccount(store)).toEqual({ seedId: 1, index: 2 });
  });
});

describe('accountScopeKey', () => {
  test('seed 0 / index 0 keeps unsuffixed keys (empty string)', () => {
    expect(accountScopeKey(0, 0)).toBe('');
  });

  test('any other seedId/index combination is a non-empty, distinct scope', () => {
    const scopes = [accountScopeKey(0, 1), accountScopeKey(1, 0), accountScopeKey(1, 1), accountScopeKey(2, 3)];
    for (const scope of scopes) expect(scope).not.toBe('');
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  test('is stable for the same inputs', () => {
    expect(accountScopeKey(2, 3)).toBe(accountScopeKey(2, 3));
  });
});
