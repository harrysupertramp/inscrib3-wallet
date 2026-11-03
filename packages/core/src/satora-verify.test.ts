import { describe, expect, test } from 'bun:test';
import { hex } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { StrictVhtlcScript } from '@satora/swap';
import { verifySatoraSendQuote, maxLightningFundAmount, assertLightningFee, type SatoraSendQuote } from './satora-verify.js';

const pub = () => secp256k1.getPublicKey(secp256k1.keygen().secretKey, true);
const refundPubkey = pub();
const serverPubkey = pub();
const receiverPubkey = pub();
const paymentHash = hex.encode(secp256k1.keygen().secretKey);
const invoice = { raw: 'lnbc...', paymentHash, amountSats: 10_000, expiresAt: 0 };

const DAY = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function quoteFor(
  overrides: { server?: Uint8Array; sender?: Uint8Array; hash?: string; refundLocktime?: number; refundWithoutReceiverDelay?: number } = {},
): SatoraSendQuote {
  const base = {
    vhtlc_refund_locktime: overrides.refundLocktime ?? nowSeconds() + DAY,
    unilateral_claim_delay: 512,
    unilateral_refund_delay: 1024,
    unilateral_refund_without_receiver_delay: overrides.refundWithoutReceiverDelay ?? 2048,
  };
  const server = (overrides.server ?? serverPubkey).slice(1);
  const vhtlc = new StrictVhtlcScript({
    sender: (overrides.sender ?? refundPubkey).slice(1),
    receiver: receiverPubkey.slice(1),
    server,
    preimageHash: ripemd160(hex.decode(overrides.hash ?? paymentHash)),
    refundLocktime: BigInt(base.vhtlc_refund_locktime),
    unilateralClaimDelay: { type: 'seconds', value: BigInt(base.unilateral_claim_delay) },
    unilateralRefundDelay: { type: 'seconds', value: BigInt(base.unilateral_refund_delay) },
    unilateralRefundWithoutReceiverDelay: { type: 'seconds', value: BigInt(base.unilateral_refund_without_receiver_delay) },
  });
  return {
    ...base,
    arkade_vhtlc_address: vhtlc.address('ark', server).encode(),
    arkade_htlc_script_version: 1,
    receiver_pk: hex.encode(receiverPubkey),
    hash_lock: overrides.hash ?? paymentHash,
    source_amount: '10100',
    target_amount: '10000',
  };
}

const expected = { invoice, refundPubkey, serverPubkey };

describe('verifySatoraSendQuote', () => {
  test('accepts an honest quote and returns the amount to fund', () => {
    expect(verifySatoraSendQuote(quoteFor(), expected)).toBe(10_100);
  });

  test('rejects a quote locked to a different payment hash', () => {
    const other = hex.encode(secp256k1.keygen().secretKey);
    expect(() => verifySatoraSendQuote(quoteFor({ hash: other }), expected)).toThrow(/not locked to this invoice/);
  });

  test('rejects an address built on a key we do not control', () => {
    expect(() => verifySatoraSendQuote(quoteFor({ sender: pub() }), expected)).toThrow(/does not match/);
    expect(() => verifySatoraSendQuote(quoteFor({ server: pub() }), expected)).toThrow(/does not match/);
  });

  test('rejects a target amount that differs from the invoice', () => {
    expect(() => verifySatoraSendQuote({ ...quoteFor(), target_amount: '9000' }, expected)).toThrow(/invoice asks/);
  });

  test('rejects a fee above the cap', () => {
    const tooMuch = String(maxLightningFundAmount(10_000) + 1);
    expect(() => verifySatoraSendQuote({ ...quoteFor(), source_amount: tooMuch }, expected)).toThrow(/fee too high/);
  });

  test('rejects an amount below the invoice', () => {
    expect(() => verifySatoraSendQuote({ ...quoteFor(), source_amount: '9999' }, expected)).toThrow(/invalid amount/);
  });

  test('rejects an unknown script version', () => {
    expect(() => verifySatoraSendQuote({ ...quoteFor(), arkade_htlc_script_version: 2 }, expected)).toThrow(/script version/);
  });
});

describe('assertLightningFee', () => {
  test('allows up to 3% + 500 sats and rejects one sat more', () => {
    expect(maxLightningFundAmount(100_000)).toBe(103_500);
    expect(() => assertLightningFee(103_500, 100_000)).not.toThrow();
    expect(() => assertLightningFee(103_501, 100_000)).toThrow(/fee too high/);
  });
});

// Regression: Satora's own timelocks were accepted unbounded, so a hostile
// quote could keep our refund closed for years.
describe('verifySatoraSendQuote timelock bounds', () => {
  const expected = { invoice, refundPubkey, serverPubkey };

  test('a refund that opens years from now is refused', () => {
    const quote = quoteFor({ refundLocktime: nowSeconds() + 3 * 365 * DAY });
    expect(() => verifySatoraSendQuote(quote, expected)).toThrow(/refund opens too late/);
  });

  test('an exit delay near the CSV maximum is refused', () => {
    const quote = quoteFor({ refundWithoutReceiverDelay: 60 * DAY });
    expect(() => verifySatoraSendQuote(quote, expected)).toThrow(/exit delays out of range/);
  });

  test('a block-height refund locktime is refused, not compared to the clock', () => {
    const quote = quoteFor({ refundLocktime: 900_000 });
    expect(() => verifySatoraSendQuote(quote, expected)).toThrow(/not a timestamp/);
  });

  test('a refund a day out with short delays is accepted', () => {
    expect(verifySatoraSendQuote(quoteFor(), expected)).toBe(10_100);
  });
});
