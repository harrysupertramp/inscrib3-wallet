import { describe, expect, test } from 'bun:test';
import { classifyPaymentTarget, createUnifiedReceiveUri } from './payment-target.js';

// Real mainnet values: an Ark address derived from the standard BIP39 test
// vector, and a BOLT11 invoice / bech32 address of the usual shapes.
const ARK =
  'ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameeq5ydpgnhyjuyzeun9sycc5gek0d0a4yphmje25s9lwqdfafk0027450qg';
const BTC = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const BTC_LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu';

function railOf(raw: string) {
  const r = classifyPaymentTarget(raw);
  return r.ok ? r.target.rail : `ERR:${r.reason}`;
}

describe('classifyPaymentTarget', () => {
  test('recognises each bare target type', () => {
    expect(railOf(ARK)).toBe('ark');
    expect(railOf(BTC)).toBe('onchain');
    expect(railOf(BTC_LEGACY)).toBe('onchain');
    expect(railOf(INVOICE)).toBe('lightning');
  });

  test('tolerates surrounding whitespace from a paste', () => {
    expect(railOf(`  ${ARK}\n`)).toBe('ark');
  });

  // isLightningInvoice accepts the scheme prefix; the BOLT11 decoder does not.
  test('strips a lightning: scheme prefix from the target', () => {
    const r = classifyPaymentTarget(`lightning:${INVOICE}`);
    expect(r.ok && r.target.rail).toBe('lightning');
    expect(r.ok && r.target.target).toBe(INVOICE);
  });

  test('reads address and amount out of a BIP21 URI', () => {
    const r = classifyPaymentTarget(`bitcoin:${BTC}?amount=0.001`);
    expect(r.ok && r.target.rail).toBe('onchain');
    expect(r.ok && r.target.target).toBe(BTC);
    expect(r.ok && r.target.amountSats).toBe(100_000);
  });

  // Ark is cheaper and faster, so it wins when a URI offers both.
  test('prefers the ark= parameter over the onchain address, and says so', () => {
    const r = classifyPaymentTarget(`bitcoin:${BTC}?ark=${ARK}&amount=0.0005`);
    expect(r.ok && r.target.rail).toBe('ark');
    expect(r.ok && r.target.target).toBe(ARK);
    expect(r.ok && r.target.amountSats).toBe(50_000);
    expect(r.ok && r.target.note).toContain('onchain address');
  });

  test('no note when the URI only offered an ark address', () => {
    const r = classifyPaymentTarget(`bitcoin:?ark=${ARK}`);
    expect(r.ok && r.target.rail).toBe('ark');
    expect(r.ok && r.target.note).toBeUndefined();
  });

  test('rejects empty input with a prompt rather than an error', () => {
    expect(classifyPaymentTarget('   ')).toEqual({ ok: false, reason: 'Enter an address or invoice' });
  });

  // The SDK exports isLnurl but ships no rail for it, so this must be an
  // explicit "not yet", not a generic parse failure.
  test('names LNURL as unsupported rather than unrecognised', () => {
    const r = classifyPaymentTarget('lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkzurf9uq3vamnwvaz7');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('not supported yet');
  });

  test('rejects junk', () => {
    expect(classifyPaymentTarget('hello world').ok).toBe(false);
    expect(classifyPaymentTarget('bitcoin:not-an-address').ok).toBe(false);
  });
});

describe('classifyPaymentTarget BOLT12', () => {
  test('explains that BOLT12 offers are not supported, instead of "unrecognised"', () => {
    for (const raw of ['lno1qgsqvgnwgcg35z6ee2h3yczraddm72xrfua9uve2rlrm9deu7xyfzr', 'lightning:LNO1QGSQ']) {
      const r = classifyPaymentTarget(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/BOLT12/);
    }
  });
});

describe('createUnifiedReceiveUri', () => {
  test('encodes the boarding address with the Ark address as ark=', () => {
    expect(createUnifiedReceiveUri(BTC, ARK)).toBe(`bitcoin:${BTC}?ark=${ARK}`);
  });

  // Our own Send must pay the Ark side of a QR we generate.
  test('round-trips through classifyPaymentTarget as an Ark payment', () => {
    const r = classifyPaymentTarget(createUnifiedReceiveUri(BTC, ARK));
    expect(r.ok && r.target.rail).toBe('ark');
    expect(r.ok && r.target.target).toBe(ARK);
  });
});
