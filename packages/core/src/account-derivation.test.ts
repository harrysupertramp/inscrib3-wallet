import { describe, expect, test } from 'bun:test';
import { MnemonicIdentity } from '@arkade-os/sdk';
import { HDKey } from '@bitcoinerlab/descriptors-scure';
import { mnemonicToSeedSync } from '@scure/bip39';
import { accountKeyPath, deriveAccountDescriptor } from './account-derivation.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Existing funds rely on the SDK's own account-0 derivation; the descriptor
// built here for account 0 must be identical to it.
describe('deriveAccountDescriptor', () => {
  test('account 0 matches MnemonicIdentity.fromMnemonic({ isMainnet }) exactly', () => {
    const viaDefault = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: true });
    const handBuilt = deriveAccountDescriptor(TEST_MNEMONIC, true, 0);
    expect(handBuilt).toBe(viaDefault.descriptor);
  });

  test('account 0 matches on testnet too', () => {
    const viaDefault = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: false });
    const handBuilt = deriveAccountDescriptor(TEST_MNEMONIC, false, 0);
    expect(handBuilt).toBe(viaDefault.descriptor);
  });

  test('different account indices produce different descriptors', () => {
    const account0 = deriveAccountDescriptor(TEST_MNEMONIC, true, 0);
    const account1 = deriveAccountDescriptor(TEST_MNEMONIC, true, 1);
    const account2 = deriveAccountDescriptor(TEST_MNEMONIC, true, 2);
    expect(new Set([account0, account1, account2]).size).toBe(3);
  });

  test('the same mnemonic/network/index always derives the same descriptor', () => {
    expect(deriveAccountDescriptor(TEST_MNEMONIC, true, 1)).toBe(deriveAccountDescriptor(TEST_MNEMONIC, true, 1));
  });

  // MnemonicIdentity re-derives the xpub and throws on mismatch, so building
  // one proves the descriptor is correct.
  test('a non-zero account index round-trips through MnemonicIdentity.fromMnemonic without an xpub mismatch', () => {
    const descriptor = deriveAccountDescriptor(TEST_MNEMONIC, true, 1);
    expect(() => MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { descriptor })).not.toThrow();
  });

  test('account 1 is a genuinely different identity from account 0', async () => {
    const account0 = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: true });
    const account1 = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
      descriptor: deriveAccountDescriptor(TEST_MNEMONIC, true, 1),
    });
    expect(await account1.xOnlyPublicKey()).not.toEqual(await account0.xOnlyPublicKey());
  });
});

// A different seed's account 0 needs nothing special: same path, different
// master seed.
describe('a second independent seed', () => {
  const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

  test("its account 0 is a different identity from the first seed's account 0", async () => {
    const seed0Account0 = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: true });
    const seed1Account0 = MnemonicIdentity.fromMnemonic(OTHER_MNEMONIC, { isMainnet: true });
    expect(await seed1Account0.xOnlyPublicKey()).not.toEqual(await seed0Account0.xOnlyPublicKey());
  });

  test('its own account 1 (via deriveAccountDescriptor) is distinct from both its own account 0 and the first seed entirely', async () => {
    const seed1Account0 = MnemonicIdentity.fromMnemonic(OTHER_MNEMONIC, { isMainnet: true });
    const seed1Account1 = MnemonicIdentity.fromMnemonic(OTHER_MNEMONIC, {
      descriptor: deriveAccountDescriptor(OTHER_MNEMONIC, true, 1),
    });
    const seed0Account0 = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: true });
    const keys = await Promise.all([seed1Account0, seed1Account1, seed0Account0].map((id) => id.xOnlyPublicKey()));
    const hexKeys = keys.map((k) => Buffer.from(k).toString('hex'));
    expect(new Set(hexKeys).size).toBe(3);
  });
});

// The Accounts screen shows this path so the account can be restored in
// another wallet; it must name the key the wallet really uses.
describe('accountKeyPath', () => {
  const cases = [
    { isMainnet: true, accountIndex: 0, path: "m/86'/0'/0'/0/0" },
    { isMainnet: true, accountIndex: 2, path: "m/86'/0'/2'/0/0" },
    { isMainnet: false, accountIndex: 0, path: "m/86'/1'/0'/0/0" },
    { isMainnet: false, accountIndex: 1, path: "m/86'/1'/1'/0/0" },
  ];

  for (const { isMainnet, accountIndex, path } of cases) {
    test(`${path} is the key the wallet signs with`, async () => {
      expect(accountKeyPath(isMainnet, accountIndex)).toBe(path);
      const identity =
        accountIndex === 0
          ? MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet })
          : MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { descriptor: deriveAccountDescriptor(TEST_MNEMONIC, isMainnet, accountIndex) });
      const keyAtPath = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive(path).publicKey!.slice(1);
      expect(await identity.xOnlyPublicKey()).toEqual(keyAtPath);
    });
  }
});
