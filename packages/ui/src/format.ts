import type { AssetEntry } from '@inscrib3/core';

// toLocaleString() defaults to 3 fraction digits and rounds up
// (0.99996 -> "1"), which would overstate a balance.
export function formatAssetAmount(asset: AssetEntry): string {
  return asset.displayAmount.toLocaleString(undefined, {
    maximumFractionDigits: Math.max(asset.metadata?.decimals ?? 0, 0),
  });
}

// Exact decimal string -> raw units. null for malformed input, more fraction
// digits than the asset has, or a value past MAX_SAFE_INTEGER - never rounded,
// so a send can't silently move more than was typed.
export function parseAssetAmount(input: string, decimals: number): number | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(input.trim());
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  const places = Math.max(decimals, 0);
  if (fraction.length > places) return null;
  const raw = BigInt((whole || '0') + fraction.padEnd(places, '0'));
  return raw > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(raw);
}

// Raw units -> exact decimal string, the inverse of parseAssetAmount.
export function rawToDecimalString(raw: number, decimals: number): string {
  const places = Math.max(decimals, 0);
  const digits = BigInt(raw).toString().padStart(places + 1, '0');
  if (places === 0) return digits;
  const fraction = digits.slice(-places).replace(/0+$/, '');
  const whole = digits.slice(0, -places);
  return fraction ? `${whole}.${fraction}` : whole;
}

// An error as the user should read it: without the "Error: " prefixes that
// String(e) and messages relayed through the background add.
export function errorText(e: unknown): string {
  return String(e).replace(/^(Error:\s*)+/, '');
}
