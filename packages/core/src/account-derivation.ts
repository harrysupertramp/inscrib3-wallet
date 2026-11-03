import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey, networks, scriptExpressions } from '@bitcoinerlab/descriptors-scure';

// The one key an account signs with and receives on (Ark, boarding and exit
// fees alike). The SDK runs in static mode, never rotating addresses, so it is
// always index 0 of the account's BIP86 descriptor.
export function accountKeyPath(isMainnet: boolean, accountIndex: number): string {
  const coinType = isMainnet ? 0 : 1;
  return `m/86'/${coinType}'/${accountIndex}'/0/0`;
}

// Same tr([fp/86'/coin'/account']xpub/0/*) descriptor the SDK builds for
// account 0, for any other account index.
export function deriveAccountDescriptor(mnemonic: string, isMainnet: boolean, accountIndex: number): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const network = isMainnet ? networks.bitcoin : networks.testnet;
  const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
  return scriptExpressions.trBIP32({ masterNode, network, account: accountIndex, change: 0, index: '*' });
}
