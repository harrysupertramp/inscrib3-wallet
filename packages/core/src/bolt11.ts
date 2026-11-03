import { decode } from 'light-bolt11-decoder';
import type { InvoiceFacts } from '@arkade-os/swap';

// Facts the swap SDK checks against the solver's claims. The decoder reports
// millisatoshis, converted to sats here.
export function decodeInvoice(raw: string): InvoiceFacts {
  const decoded = decode(raw);
  const amountSection = decoded.sections.find((s) => s.name === 'amount');
  const paymentHashSection = decoded.sections.find((s) => s.name === 'payment_hash');
  const timestampSection = decoded.sections.find((s) => s.name === 'timestamp');

  if (!amountSection || typeof amountSection.value !== 'string') {
    throw new Error('Lightning invoice has no amount - zero-amount invoices are not supported');
  }
  if (!paymentHashSection || typeof paymentHashSection.value !== 'string') {
    throw new Error('Lightning invoice has no payment hash');
  }
  if (!timestampSection || typeof timestampSection.value !== 'number') {
    throw new Error('Lightning invoice has no timestamp');
  }

  const amountSats = Math.floor(Number(amountSection.value) / 1000);
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error('Lightning invoice amount is invalid');
  }

  return {
    raw,
    paymentHash: paymentHashSection.value.toLowerCase(),
    amountSats,
    expiresAt: timestampSection.value + decoded.expiry,
  };
}
