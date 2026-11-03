import type { KeyValueStore } from './key-value-store.js';

function encryptedMnemonicKey(seedId: number): string {
  return seedId === 0 ? 'arkade:wallet:encrypted' : `arkade:wallet:encrypted:${seedId}`;
}
const PBKDF2_ITERATIONS = 600_000;

export interface EncryptedPayload {
  salt: string;  // hex
  iv: string;    // hex
  ciphertext: string; // hex
}

// Uint8Array<ArrayBuffer>: crypto.subtle rejects Uint8Array<ArrayBufferLike>.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function randomSaltHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function encryptWithKey(plaintext: string, key: CryptoKey, salt: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { salt, iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ciphertext)) };
}

async function decryptWithKey(payload: EncryptedPayload, key: CryptoKey): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(payload.iv) },
    key,
    hexToBytes(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<EncryptedPayload> {
  const salt = randomSaltHex();
  return encryptWithKey(mnemonic, await deriveKey(password, hexToBytes(salt)), salt);
}

export async function decryptMnemonic(payload: EncryptedPayload, password: string): Promise<string> {
  return decryptWithKey(payload, await deriveKey(password, hexToBytes(payload.salt)));
}

// For data rewritten often while unlocked (swap state): derives the key once
// per salt instead of on every call. Every encryption still gets a fresh IV,
// so reusing the key is safe for AES-GCM.
export class PasswordCipher {
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private writeSalt: string | null = null;

  constructor(private readonly password: string) {}

  private key(salt: string): Promise<CryptoKey> {
    let key = this.keys.get(salt);
    if (!key) {
      key = deriveKey(this.password, hexToBytes(salt));
      this.keys.set(salt, key);
    }
    return key;
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    this.writeSalt ??= randomSaltHex();
    return encryptWithKey(plaintext, await this.key(this.writeSalt), this.writeSalt);
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    return decryptWithKey(payload, await this.key(payload.salt));
  }
}

export async function saveEncryptedMnemonic(store: KeyValueStore, payload: EncryptedPayload, seedId = 0): Promise<void> {
  await store.set(encryptedMnemonicKey(seedId), JSON.stringify(payload));
}

export async function loadEncryptedMnemonic(store: KeyValueStore, seedId = 0): Promise<EncryptedPayload | null> {
  const raw = await store.get<string>(encryptedMnemonicKey(seedId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EncryptedPayload;
  } catch {
    // Distinct from a wrong password: retrying can never fix corrupted data.
    throw new Error('WALLET_DATA_CORRUPTED');
  }
}

// For seed 0 this answers "is a wallet set up at all".
export async function hasStoredWallet(store: KeyValueStore, seedId = 0): Promise<boolean> {
  const raw = await store.get<string>(encryptedMnemonicKey(seedId));
  return raw !== undefined;
}
