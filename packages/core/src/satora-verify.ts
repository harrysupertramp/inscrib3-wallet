import { hex } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { ArkAddress } from '@arkade-os/sdk';
import { StrictVhtlcScript, ARKADE_HTLC_SCRIPT_VERSION_STRICT } from '@satora/swap';
import type { InvoiceFacts } from '@arkade-os/swap';

// Upper bound on what a Lightning send may cost on top of the invoice.
export const MAX_LIGHTNING_FEE_RATE = 0.03;
export const MAX_LIGHTNING_FEE_FLAT_SATS = 500;

export function maxLightningFundAmount(invoiceSats: number): number {
  return invoiceSats + Math.ceil(invoiceSats * MAX_LIGHTNING_FEE_RATE) + MAX_LIGHTNING_FEE_FLAT_SATS;
}

// How long our own refund may stay closed. Satora picks these numbers; without
// a cap a hostile quote could lock the refund for years, past the VTXO's own
// expiry. Generous on purpose: mainnet's unilateral exit delay is ~7 days.
const SECONDS_PER_DAY = 86_400;
export const MAX_SATORA_REFUND_LOCKTIME_AHEAD_SECONDS = 7 * SECONDS_PER_DAY;
export const MAX_SATORA_UNILATERAL_DELAY_SECONDS = 14 * SECONDS_PER_DAY;
// Below this a CLTV value is a block height, not a unix time.
const LOCKTIME_THRESHOLD = 500_000_000;

function assertSatoraTimelocksBounded(quote: SatoraSendQuote, nowSeconds: number): void {
  const locktime = quote.vhtlc_refund_locktime;
  if (!Number.isInteger(locktime) || locktime < LOCKTIME_THRESHOLD) {
    throw new Error(`Lightning swap refund locktime is not a timestamp: ${locktime}`);
  }
  if (locktime > nowSeconds + MAX_SATORA_REFUND_LOCKTIME_AHEAD_SECONDS) {
    throw new Error(`Lightning swap refund opens too late: ${new Date(locktime * 1000).toISOString()}`);
  }
  const delays = [quote.unilateral_claim_delay, quote.unilateral_refund_delay, quote.unilateral_refund_without_receiver_delay];
  if (delays.some((d) => !Number.isInteger(d) || d <= 0 || d > MAX_SATORA_UNILATERAL_DELAY_SECONDS)) {
    throw new Error(`Lightning swap exit delays out of range: ${delays.join(', ')} seconds`);
  }
}

export function assertLightningFee(fundAmount: number, invoiceSats: number): void {
  if (fundAmount > maxLightningFundAmount(invoiceSats)) {
    throw new Error(`Lightning fee too high: ${fundAmount - invoiceSats} sats on a ${invoiceSats} sat invoice`);
  }
}

export interface SatoraSendQuote {
  arkade_vhtlc_address: string;
  arkade_htlc_script_version: number;
  receiver_pk: string;
  hash_lock: string;
  source_amount: string;
  target_amount: string;
  vhtlc_refund_locktime: number;
  unilateral_claim_delay: number;
  unilateral_refund_delay: number;
  unilateral_refund_without_receiver_delay: number;
}

function xOnly(key: Uint8Array): Uint8Array {
  if (key.length === 33) return key.slice(1);
  if (key.length === 32) return key;
  throw new Error(`Invalid public key length ${key.length}`);
}

function seconds(value: number) {
  return { type: 'seconds' as const, value: BigInt(value) };
}

// Satora's SDK funds whatever address and amount its API returns. Rebuilding
// the VHTLC from values we control (our refund key, our Ark server key, the
// invoice's own payment hash) proves the funds can only be claimed by paying
// this invoice, and refunded to us otherwise, within the bounds above.
export function verifySatoraSendQuote(
  quote: SatoraSendQuote,
  expected: { invoice: InvoiceFacts; refundPubkey: Uint8Array; serverPubkey: Uint8Array },
  nowSeconds = Math.floor(Date.now() / 1000),
): number {
  const { invoice } = expected;
  if (quote.arkade_htlc_script_version !== ARKADE_HTLC_SCRIPT_VERSION_STRICT) {
    throw new Error(`Unsupported Lightning swap script version ${quote.arkade_htlc_script_version}`);
  }
  if (quote.hash_lock.replace(/^0x/, '').toLowerCase() !== invoice.paymentHash) {
    throw new Error('Lightning swap is not locked to this invoice');
  }
  if (Number(quote.target_amount) !== invoice.amountSats) {
    throw new Error(`Lightning swap pays ${quote.target_amount} sats, invoice asks ${invoice.amountSats}`);
  }
  const fundAmount = Number(quote.source_amount);
  if (!Number.isInteger(fundAmount) || fundAmount < invoice.amountSats) {
    throw new Error(`Lightning swap quoted an invalid amount: ${quote.source_amount}`);
  }
  assertLightningFee(fundAmount, invoice.amountSats);
  assertSatoraTimelocksBounded(quote, nowSeconds);

  const server = xOnly(expected.serverPubkey);
  const vhtlc = new StrictVhtlcScript({
    sender: xOnly(expected.refundPubkey),
    receiver: xOnly(hex.decode(quote.receiver_pk)),
    server,
    preimageHash: ripemd160(hex.decode(invoice.paymentHash)),
    refundLocktime: BigInt(quote.vhtlc_refund_locktime),
    unilateralClaimDelay: seconds(quote.unilateral_claim_delay),
    unilateralRefundDelay: seconds(quote.unilateral_refund_delay),
    unilateralRefundWithoutReceiverDelay: seconds(quote.unilateral_refund_without_receiver_delay),
  });
  const hrp = ArkAddress.decode(quote.arkade_vhtlc_address).hrp;
  if (vhtlc.address(hrp, server).encode() !== quote.arkade_vhtlc_address) {
    throw new Error('Lightning swap address does not match its own parameters');
  }
  return fundAmount;
}
