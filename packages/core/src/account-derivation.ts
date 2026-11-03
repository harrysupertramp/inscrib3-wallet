import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey, networks, scriptExpressions } from '@bitcoinerlab/descriptors-scure';

// Same tr([fp/86'/coin'/account']xpub/0/*) descriptor the SDK builds for
// account 0, for any other account index.
export function deriveAccountDescriptor(mnemonic: string, isMainnet: boolean, accountIndex: number): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const network = isMainnet ? networks.bitcoin : networks.testnet;
  const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
  return scriptExpressions.trBIP32({ masterNode, network, account: accountIndex, change: 0, index: '*' });
}
