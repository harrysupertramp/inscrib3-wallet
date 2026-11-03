import { describe, expect, test } from 'bun:test';
import { assertValidAmount, assertValidAddress, assertValidPassword } from './validation.js';

describe('assertValidAmount', () => {
  test('accepts a positive integer', () => {
    expect(() => assertValidAmount(1000)).not.toThrow();
  });

  for (const bad of [-1000, 0, NaN, 1.5, Infinity, -Infinity]) {
    test(`rejects ${bad}`, () => {
      expect(() => assertValidAmount(bad)).toThrow(/Invalid amount/);
    });
  }

  test('uses a custom label in the error message', () => {
    expect(() => assertValidAmount(-1, 'bitcoinAmount')).toThrow(/Invalid bitcoinAmount/);
  });
});

describe('assertValidAddress', () => {
  test('accepts a non-empty string', () => {
    expect(() => assertValidAddress('ark1qsomeaddress')).not.toThrow();
  });

  test('rejects an empty string', () => {
    expect(() => assertValidAddress('')).toThrow(/Invalid address/);
  });

  test('rejects a whitespace-only string', () => {
    expect(() => assertValidAddress('   ')).toThrow(/Invalid address/);
  });
});

describe('assertValidPassword', () => {
  test('accepts a 4+ character password', () => {
    expect(() => assertValidPassword('abcd')).not.toThrow();
  });

  test('rejects a password under 4 characters', () => {
    expect(() => assertValidPassword('abc')).toThrow(/Invalid password/);
  });

  test('rejects an empty password', () => {
    expect(() => assertValidPassword('')).toThrow(/Invalid password/);
  });
});
