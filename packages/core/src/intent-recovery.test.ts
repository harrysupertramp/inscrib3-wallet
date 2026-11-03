import { describe, expect, test } from 'bun:test';
import type { ArkIntent, IntentRepository, VirtualCoin } from '@arkade-os/sdk';
import { releaseStaleIntents, reservedAsset, STALE_INTENT_MS, unfinishedIntents } from './intent-recovery.js';

const NOW = 10_000_000_000;
const ASSET = 'ab'.repeat(34);

function intent(id: string, state: ArkIntent['state'], updatedAt: number): ArkIntent {
  return {
    intentTxId: id,
    state,
    createdAt: updatedAt,
    updatedAt,
    registerProof: 'r',
    registerProofMessage: '{}',
    deleteProof: 'p',
    deleteProofMessage: '{"type":"delete","expire_at":0}',
    partialForfeits: [],
    intentVtxos: [{ txid: id.repeat(64).slice(0, 64), vout: 0 }],
  };
}

// Keeps updatedAt as given (the SDK's in-memory repo stamps it with the real clock).
function fakeRepo(): IntentRepository {
  const all = new Map<string, ArkIntent>();
  return {
    getIntentsPage: async () => ({ items: [...all.values()] }),
    saveIntent: async (i: ArkIntent) => void all.set(i.intentTxId, i),
  } as unknown as IntentRepository;
}

describe('stale settlement intents (O-12)', () => {
  test('releases only unfinished intents with no progress for 15 minutes, asking the server to drop them', async () => {
    const repo = fakeRepo();
    await repo.saveIntent(intent('a', 'batch_in_progress', NOW - STALE_INTENT_MS - 1));
    await repo.saveIntent(intent('b', 'waiting_for_batch', NOW - 60_000));
    await repo.saveIntent(intent('c', 'batch_succeeded', NOW - STALE_INTENT_MS - 1));
    const deleted: unknown[] = [];
    const released = await releaseStaleIntents(repo, { deleteIntent: async (i) => void deleted.push(i) }, NOW);
    expect(released).toBe(1);
    expect(deleted).toEqual([{ proof: 'p', message: { type: 'delete', expire_at: 0 } }]);
    expect((await unfinishedIntents(repo)).map((i) => i.intentTxId)).toEqual(['b']);
  });

  test('a server that refuses the delete still leaves the coins freed locally', async () => {
    const repo = fakeRepo();
    await repo.saveIntent(intent('a', 'waiting_for_batch', NOW - STALE_INTENT_MS - 1));
    await releaseStaleIntents(repo, { deleteIntent: async () => { throw new Error('not found'); } }, NOW);
    expect(await unfinishedIntents(repo)).toEqual([]);
  });

  test('reservedAsset sums the asset an intent holds and says when the oldest can be freed', () => {
    const held = intent('a', 'waiting_for_batch', NOW);
    const coin = { txid: held.intentVtxos[0].txid, vout: 0, assets: [{ assetId: ASSET, amount: 140n }] } as unknown as VirtualCoin;
    expect(reservedAsset([held], [coin], ASSET)).toEqual({ amount: 140n, releasableAt: NOW + STALE_INTENT_MS });
    expect(reservedAsset([held], [coin], 'cd'.repeat(34)).amount).toBe(0n);
  });
});
