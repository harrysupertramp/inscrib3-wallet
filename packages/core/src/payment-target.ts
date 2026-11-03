import { BIP21, isValidArkAddress, isBtcAddress, isLightningInvoice, isLnurl } from '@arkade-os/sdk';

export type PaymentRail = 'ark' | 'onchain' | 'lightning';

export interface PaymentTarget {
  rail: PaymentRail;
  /** Exactly what the rail's send path should be handed - prefixes stripped. */
  target: string;
  /** Sats carried by a BIP21 URI, when it has an `amount=`. */
  amountSats?: number;
  /** Shown to the user when the input was ambiguous and we picked a rail. */
  note?: string;
}

export type PaymentTargetResult =
  | { ok: true; target: PaymentTarget }
  | { ok: false; reason: string };

function fail(reason: string): PaymentTargetResult {
  return { ok: false, reason };
}

// Picks the send rail from whatever was pasted. Classification only: each
// rail's send path still validates network and amount.
export function classifyPaymentTarget(raw: string): PaymentTargetResult {
  const trimmed = raw.trim();
  if (!trimmed) return fail('Enter an address or invoice');

  if (/^bitcoin:/i.test(trimmed)) return classifyBip21(trimmed);

  if (isValidArkAddress(trimmed)) return { ok: true, target: { rail: 'ark', target: trimmed } };

  if (/^(lightning:)?lno1/i.test(trimmed)) {
    return fail('BOLT12 offers (lno1…) are not supported yet - ask for a BOLT11 invoice (starts with lnbc)');
  }

  if (isLightningInvoice(trimmed)) {
    // The BOLT11 decoder doesn't accept the lightning: prefix.
    return { ok: true, target: { rail: 'lightning', target: trimmed.replace(/^lightning:/i, '') } };
  }

  if (isBtcAddress(trimmed)) return { ok: true, target: { rail: 'onchain', target: trimmed } };

  if (isLnurl(trimmed)) return fail('LNURL and Lightning addresses are not supported yet');

  return fail("Not an Ark address, Bitcoin address, or Lightning invoice");
}

// The receive screen's one QR for Arkade, in Arkade's own format
// (bitcoin:<boarding>?ark=<ark>): an Ark-aware wallet pays the Ark address,
// any other wallet pays the boarding address onchain.
export function createUnifiedReceiveUri(boardingAddress: string, arkAddress: string): string {
  return BIP21.create({ address: boardingAddress, ark: arkAddress });
}

// A BIP21 URI can carry both; Ark is preferred.
function classifyBip21(uri: string): PaymentTargetResult {
  let parsed: ReturnType<typeof BIP21.parse>;
  try {
    parsed = BIP21.parse(uri);
  } catch {
    return fail('Could not read that payment URI');
  }

  const amountSats = BIP21.amountSats(uri);
  const ark = typeof parsed.params.ark === 'string' ? parsed.params.ark : undefined;
  const address = typeof parsed.params.address === 'string' ? parsed.params.address : undefined;

  if (ark && isValidArkAddress(ark)) {
    return {
      ok: true,
      target: {
        rail: 'ark',
        target: ark,
        amountSats,
        note: address ? 'This request also had an onchain address; using the Ark one.' : undefined,
      },
    };
  }

  if (address && isBtcAddress(address)) {
    return { ok: true, target: { rail: 'onchain', target: address, amountSats } };
  }

  return fail('That payment URI has no usable address');
}
