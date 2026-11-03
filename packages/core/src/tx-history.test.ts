import { describe, expect, test } from 'bun:test';
import { TxType } from '@arkade-os/sdk';
import { toHistoryEntry } from './tx-history.js';

// Minimal shape matching what toHistoryEntry actually reads - not the full
// SDK transaction type, which carries a lot more this function ignores.
function mockTx(overrides: {
  arkTxid?: string;
  commitmentTxid?: string;
  boardingTxid?: string;
  type?: string;
  amount?: number;
  settled?: boolean;
  createdAt?: number;
  assets?: { assetId: string; amount: bigint }[];
}) {
  return {
    key: {
      arkTxid: overrides.arkTxid ?? '',
      commitmentTxid: overrides.commitmentTxid ?? '',
      boardingTxid: overrides.boardingTxid ?? '',
    },
    type: overrides.type ?? TxType.TxReceived,
    amount: overrides.amount ?? 1000,
    settled: overrides.settled ?? true,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    assets: overrides.assets,
  } as unknown as Parameters<typeof toHistoryEntry>[0];
}

describe('toHistoryEntry', () => {
  test('a sent transaction is classified as type "send"', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', type: TxType.TxSent }), new Set());
    expect(entry.type).toBe('send');
  });

  test('a received transaction is classified as type "receive"', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', type: TxType.TxReceived }), new Set());
    expect(entry.type).toBe('receive');
  });

  test('a settled transaction is "confirmed"', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', settled: true }), new Set());
    expect(entry.status).toBe('confirmed');
  });

  test('an unsettled transaction is "pending"', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', settled: false }), new Set());
    expect(entry.status).toBe('pending');
  });

  test('txid prefers arkTxid over commitmentTxid and boardingTxid', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'ark-1', commitmentTxid: 'commit-1', boardingTxid: 'board-1' }), new Set());
    expect(entry.txid).toBe('ark-1');
  });

  test('txid falls back to commitmentTxid when arkTxid is absent', () => {
    const entry = toHistoryEntry(mockTx({ commitmentTxid: 'commit-1', boardingTxid: 'board-1' }), new Set());
    expect(entry.txid).toBe('commit-1');
  });

  test('txid falls back to boardingTxid when neither arkTxid nor commitmentTxid is present', () => {
    const entry = toHistoryEntry(mockTx({ boardingTxid: 'board-1' }), new Set());
    expect(entry.txid).toBe('board-1');
  });

  test('a boarding transaction (has boardingTxid) is tagged layer "onchain"', () => {
    const entry = toHistoryEntry(mockTx({ boardingTxid: 'board-1' }), new Set());
    expect(entry.layer).toBe('onchain');
  });

  test('a plain ark transaction (no boardingTxid) is tagged layer "ark"', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'ark-1' }), new Set());
    expect(entry.layer).toBe('ark');
  });

  test('a txid present in the known-lightning set is tagged layer "lightning", overriding the boarding check', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'lightning-tx-1' }), new Set(['lightning-tx-1']));
    expect(entry.layer).toBe('lightning');
  });

  test('timestamp is converted from milliseconds to unix seconds', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', createdAt: 1_700_000_000_000 }), new Set());
    expect(entry.timestamp).toBe(1_700_000_000);
  });

  test('amount passes through unchanged', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'tx1', amount: 54321 }), new Set());
    expect(entry.amount).toBe(54321);
  });

  test('onchainTxid is the commitment txid for a settle/round entry (a real Bitcoin txid, not the off-chain arkTxid)', () => {
    const entry = toHistoryEntry(mockTx({ commitmentTxid: 'commit-1' }), new Set());
    expect(entry.onchainTxid).toBe('commit-1');
  });

  test('onchainTxid is the boarding txid for a boarding send', () => {
    const entry = toHistoryEntry(mockTx({ boardingTxid: 'board-1' }), new Set());
    expect(entry.onchainTxid).toBe('board-1');
  });

  test('onchainTxid is absent for a plain Ark send/receive - it has no Bitcoin L1 counterpart', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'ark-1' }), new Set());
    expect(entry.onchainTxid).toBeUndefined();
  });

  test('assets is absent for a plain BTC transaction', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'ark-1' }), new Set());
    expect(entry.assets).toBeUndefined();
  });

  test('assets is absent when the SDK reports an empty assets array', () => {
    const entry = toHistoryEntry(mockTx({ arkTxid: 'ark-1', assets: [] }), new Set());
    expect(entry.assets).toBeUndefined();
  });

  test('assets carries assetId/amount pairs, converting bigint amounts to number', () => {
    const entry = toHistoryEntry(
      mockTx({ arkTxid: 'ark-1', assets: [{ assetId: 'asset-1', amount: 500n }] }),
      new Set(),
    );
    expect(entry.assets).toEqual([{ assetId: 'asset-1', amount: 500 }]);
  });

  test('isMint is true when the asset id\'s embedded genesis txid matches this tx - i.e. this tx IS the creation event', () => {
    const genesisArkTxid = 'a'.repeat(64);
    const assetId = `${genesisArkTxid}0000`;
    const entry = toHistoryEntry(
      mockTx({ arkTxid: genesisArkTxid, assets: [{ assetId, amount: 100n }] }),
      new Set(),
    );
    expect(entry.assets).toEqual([{ assetId, amount: 100, isMint: true }]);
  });

  test('isMint is absent for an ordinary transfer of an already-existing asset (different arkTxid than the genesis)', () => {
    const genesisArkTxid = 'a'.repeat(64);
    const assetId = `${genesisArkTxid}0000`;
    const entry = toHistoryEntry(
      mockTx({ arkTxid: 'b'.repeat(64), assets: [{ assetId, amount: 100n }] }),
      new Set(),
    );
    expect(entry.assets).toEqual([{ assetId, amount: 100 }]);
  });

  test('assets carries multiple entries for a multi-asset transaction', () => {
    const entry = toHistoryEntry(
      mockTx({
        arkTxid: 'ark-1',
        assets: [
          { assetId: 'asset-1', amount: 500n },
          { assetId: 'asset-2', amount: 250n },
        ],
      }),
      new Set(),
    );
    expect(entry.assets).toEqual([
      { assetId: 'asset-1', amount: 500 },
      { assetId: 'asset-2', amount: 250 },
    ]);
  });
});
