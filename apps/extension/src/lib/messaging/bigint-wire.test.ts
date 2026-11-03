import { describe, expect, test } from 'bun:test';
import { encodeBigints, decodeBigints } from './bigint-wire.js';

// Extension messaging serializes like JSON, so this is the real round trip.
const overTheWire = (value: unknown) => decodeBigints(JSON.parse(JSON.stringify(encodeBigints(value))));

describe('bigint wire encoding', () => {
  test('nested bigints survive extension messaging exactly', () => {
    const balance = { confirmed: 46_766n, unconfirmed: 0n };
    const assets = [{ assetId: 'a1', amount: 100_000_000_000_000_000_000n }];
    expect(overTheWire({ balance, assets })).toEqual({ balance, assets });
  });

  test('plain values pass through untouched', () => {
    const value = { a: 1, b: 'x', c: [true, null], d: { e: 2.5 } };
    expect(overTheWire(value)).toEqual(value);
  });

  test('a raw bigint is what breaks plain JSON', () => {
    expect(() => JSON.stringify({ amount: 1n })).toThrow();
    expect(() => JSON.stringify(encodeBigints({ amount: 1n }))).not.toThrow();
  });
});
