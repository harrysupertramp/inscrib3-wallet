import { describe, expect, test } from 'bun:test';
import { decodeInvoice } from './bolt11.js';

// Test vectors from the BOLT #11 specification.
const PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
const COFFEE_2500U =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const DONATION_NO_AMOUNT =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';

describe('decodeInvoice', () => {
  test('converts the msat amount to sats and reads hash and expiry', () => {
    const facts = decodeInvoice(COFFEE_2500U);
    expect(facts.amountSats).toBe(250_000);
    expect(facts.paymentHash).toBe(PAYMENT_HASH);
    // timestamp 1496314658 + 60 s expiry
    expect(facts.expiresAt).toBe(1_496_314_718);
    expect(facts.raw).toBe(COFFEE_2500U);
  });

  test('rejects a zero-amount invoice', () => {
    expect(() => decodeInvoice(DONATION_NO_AMOUNT)).toThrow(/zero-amount/);
  });

  test('rejects garbage', () => {
    expect(() => decodeInvoice('lnbc1notaninvoice')).toThrow();
  });
});
