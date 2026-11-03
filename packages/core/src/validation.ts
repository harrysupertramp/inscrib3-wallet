import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// Collapses pasted whitespace and case. Must run before storing: a stored
// phrase is never re-normalized.
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
}

export function assertValidMnemonic(mnemonic: string): void {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid seed phrase - check the words and their order');
  }
}

// Last check before funds move; the approval popup doesn't block bad amounts.
export function assertValidAmount(amount: number, label = 'amount'): void {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Invalid ${label}: must be a positive integer`);
  }
}

export function assertValidAddress(address: string, label = 'address'): void {
  if (typeof address !== 'string' || address.trim().length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
}

// Also enforced in SetupScreen; repeated here for direct callers.
export function assertValidPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('Invalid password: must be at least 4 characters');
  }
}

export function assertValidVtxoOutpoint(ref: unknown, label = 'vtxo'): asserts ref is { txid: string; vout: number } {
  const r = ref as { txid?: unknown; vout?: unknown } | null | undefined;
  if (
    typeof r?.txid !== 'string' ||
    r.txid.trim().length === 0 ||
    typeof r?.vout !== 'number' ||
    !Number.isInteger(r.vout) ||
    r.vout < 0
  ) {
    throw new Error(`Invalid ${label}: must be {txid: string, vout: non-negative integer}`);
  }
}
