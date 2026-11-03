import { describe, expect, test } from 'bun:test';
import { dbNameFor } from './storage.js';

// DB names must be scoped by network and account, or one network's synced
// state would be read back under another.
describe('dbNameFor', () => {
  test('mainnet and mutinynet get different names', () => {
    expect(dbNameFor('wallet', 'bitcoin', 0)).not.toBe(dbNameFor('wallet', 'mutinynet', 0));
  });

  test('the network name is embedded in the db name', () => {
    expect(dbNameFor('wallet', 'bitcoin', 0)).toContain('bitcoin');
  });

  test('contracts and intents prefixes are also scoped by network', () => {
    expect(dbNameFor('contracts', 'mutinynet', 0)).toContain('mutinynet');
    expect(dbNameFor('intents', 'mutinynet', 0)).toContain('mutinynet');
  });

  test('two calls for the same network produce the same db name (stable, not random)', () => {
    expect(dbNameFor('wallet', 'bitcoin', 0)).toBe(dbNameFor('wallet', 'bitcoin', 0));
  });

  // Existing funds depend on account 0's exact db names.
  test('account 0 produces the exact unsuffixed name existing installs already use', () => {
    expect(dbNameFor('wallet', 'bitcoin', 0)).toBe('arkade-wallet-bitcoin');
  });

  test('account index >= 1 is scoped separately from account 0 and from each other', () => {
    const account0 = dbNameFor('wallet', 'bitcoin', 0);
    const account1 = dbNameFor('wallet', 'bitcoin', 1);
    const account2 = dbNameFor('wallet', 'bitcoin', 2);
    expect(new Set([account0, account1, account2]).size).toBe(3);
    expect(account1).toContain('1');
    expect(account2).toContain('2');
  });
});
