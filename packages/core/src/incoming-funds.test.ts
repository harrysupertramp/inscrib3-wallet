import { describe, expect, test } from 'bun:test';
import type { IncomingFunds } from '@arkade-os/sdk';
import { IncomingFundsFilter, type IncomingFundsSummary } from './incoming-funds.js';

const settle = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const emitted: IncomingFundsSummary[] = [];
  const filter = new IncomingFundsFilter((s) => emitted.push(s), 1);
  return { filter, emitted };
}

const vtxo = (txid: string, vout: number, value: number, extra: Record<string, unknown> = {}) =>
  ({ txid, vout, value, ...extra }) as never;
const vtxoEvent = (newVtxos: unknown[], spentVtxos: unknown[] = []) =>
  ({ type: 'vtxo', newVtxos, spentVtxos }) as unknown as IncomingFunds;

describe('IncomingFundsFilter', () => {
  test('a payment from someone else is announced', async () => {
    const { filter, emitted } = setup();
    filter.handle(vtxoEvent([vtxo('pay', 0, 1000)]));
    await settle();
    expect(emitted).toEqual([{ type: 'vtxo', count: 1, amountSats: 1000 }]);
  });

  // Regression: a send to ourselves showed "Received 660 sats" (both outputs).
  test('change and self-send outputs of our own tx are not announced', async () => {
    const { filter, emitted } = setup();
    filter.handle(vtxoEvent([vtxo('ourSend', 0, 330), vtxo('ourSend', 1, 330)]));
    filter.handle(vtxoEvent([], [vtxo('oldCoin', 0, 660, { arkTxId: 'ourSend' })]));
    await settle();
    expect(emitted).toEqual([]);
  });

  test('a txid marked as ours directly is not announced either', async () => {
    const { filter, emitted } = setup();
    filter.handle(vtxoEvent([vtxo('ourSend', 1, 500)]));
    filter.markOwnTx('ourSend');
    await settle();
    expect(emitted).toEqual([]);
  });

  test('VTXOs recreated by a renewal (same batch as the spent ones) are not announced', async () => {
    const { filter, emitted } = setup();
    filter.handle(vtxoEvent([], [vtxo('old', 0, 5000, { settledBy: 'batch1' })]));
    filter.handle(vtxoEvent([vtxo('leaf', 0, 5000, { commitmentTxIds: ['batch1'] })]));
    await settle();
    expect(emitted).toEqual([]);
  });

  test('the same coin reported twice is announced once', async () => {
    const { filter, emitted } = setup();
    filter.handle(vtxoEvent([vtxo('pay', 0, 1000)]));
    filter.handle(vtxoEvent([vtxo('pay', 0, 1000)]));
    await settle();
    filter.handle(vtxoEvent([vtxo('pay', 0, 1000)]));
    await settle();
    expect(emitted).toEqual([{ type: 'vtxo', count: 1, amountSats: 1000 }]);
  });

  test('an onchain deposit seen in the mempool and again when confirmed is announced once', () => {
    const { filter, emitted } = setup();
    const coin = { txid: 'dep', vout: 0, value: 2000 };
    filter.handle({ type: 'utxo', coins: [coin] } as unknown as IncomingFunds);
    filter.handle({ type: 'utxo', coins: [coin] } as unknown as IncomingFunds);
    expect(emitted).toEqual([{ type: 'utxo', count: 1, amountSats: 2000 }]);
  });
});
