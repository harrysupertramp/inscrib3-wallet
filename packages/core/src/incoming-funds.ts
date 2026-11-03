import type { IncomingFunds } from '@arkade-os/sdk';

// What a listener gets when funds land: flattened, since it crosses the
// extension's message boundary.
export interface IncomingFundsSummary {
  type: 'utxo' | 'vtxo';
  count: number;
  amountSats: number;
}

type NewVtxo = { txid: string; vout: number; value: number; commitmentTxIds?: string[] };

// How long a new VTXO waits for the matching "spent" events before it is
// judged; they come from the same indexer update, usually milliseconds apart.
const SETTLE_DELAY_MS = 3_000;
// Own-tx memory only has to outlive that window.
const OWN_TX_TTL_MS = 10 * 60_000;

// Turns raw SDK funds events into "someone paid you" notifications. The SDK
// also reports VTXOs our own actions create - change from a send, outputs of
// a send to ourselves, and the VTXOs a renewal or settlement recreates - and
// each coin can be reported more than once. Those are dropped here.
export class IncomingFundsFilter {
  private readonly ownTxids = new Map<string, number>();
  private readonly seen = new Set<string>();
  private pending: NewVtxo[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (summary: IncomingFundsSummary) => void,
    private readonly delayMs = SETTLE_DELAY_MS,
  ) {}

  // A transaction this wallet created (offchain send, settlement batch).
  markOwnTx(txid: string): void {
    this.ownTxids.set(txid, Date.now());
  }

  handle(funds: IncomingFunds): void {
    if (funds.type === 'utxo') {
      const fresh = funds.coins.filter((c) => this.firstSighting(`${c.txid}:${c.vout}`));
      if (fresh.length > 0) this.emit(summarize('utxo', fresh));
      return;
    }
    // A spent VTXO names the tx that consumed it: anything that tx (or batch)
    // created was funded by us.
    for (const v of funds.spentVtxos) {
      for (const txid of [v.arkTxId, v.settledBy, v.spentBy]) if (txid) this.markOwnTx(txid);
    }
    for (const v of funds.newVtxos) {
      if (this.firstSighting(`${v.txid}:${v.vout}`)) this.pending.push(v);
    }
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  private flush(): void {
    this.timer = null;
    const incoming = this.pending.filter(
      (v) => !this.ownTxids.has(v.txid) && !(v.commitmentTxIds ?? []).some((c) => this.ownTxids.has(c)),
    );
    this.pending = [];
    const cutoff = Date.now() - OWN_TX_TTL_MS;
    for (const [txid, at] of this.ownTxids) if (at < cutoff) this.ownTxids.delete(txid);
    if (incoming.length > 0) this.emit(summarize('vtxo', incoming));
  }

  private firstSighting(outpoint: string): boolean {
    if (this.seen.has(outpoint)) return false;
    this.seen.add(outpoint);
    return true;
  }
}

function summarize(type: 'utxo' | 'vtxo', coins: Array<{ value: number }>): IncomingFundsSummary {
  return { type, count: coins.length, amountSats: coins.reduce((sum, c) => sum + Number(c.value), 0) };
}
