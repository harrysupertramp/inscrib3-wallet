import { assertPageRequest, pageResult, type PageRequest, type PageResult } from '@arkade-os/sdk';
import type { RfqSwapPageCursor, RfqSwapPageFilter } from '@arkade-os/swap';
import type { RfqSwapRecord, RfqSwapRecordStore } from '@arkade-os/swap/protocol';
import type { KeyValueStore } from './key-value-store.js';
import { Mutex } from './mutex.js';

function storageKey(network: string, scope: string): string {
  const base = `arkade:lightning:rfq-swaps:${network}`;
  return scope ? `${base}:${scope}` : base;
}

// Matches the cursor's `>` test, which localeCompare doesn't.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// RfqSwapManager persistence on the wallet's own KeyValueStore. Low volume,
// so the whole list is read and rewritten per call; writes are serialized.
export class KeyValueRfqSwapStore implements RfqSwapRecordStore {
  private readonly writes = new Mutex();

  constructor(
    private readonly store: KeyValueStore,
    private readonly network: string,
    private readonly scope: string,
  ) {}

  private get key(): string {
    return storageKey(this.network, this.scope);
  }

  async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
    return (await this.store.get<RfqSwapRecord[]>(this.key)) ?? [];
  }

  async getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined> {
    const all = await this.getAllRfqSwaps();
    return all.find((r) => r.rfqId === rfqId);
  }

  // Same order and cursor as the SDK's own stores: (updatedAt, rfqId).
  async getRfqSwapsPage(
    filter: RfqSwapPageFilter,
    page: PageRequest<RfqSwapPageCursor>,
  ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>> {
    assertPageRequest(page);
    const after = page.after;
    const rows = (await this.getAllRfqSwaps())
      .filter((r) => filter.state === undefined || r.state === filter.state)
      .filter((r) => filter.since === undefined || r.updatedAt >= filter.since)
      .filter((r) => !after || r.updatedAt > after.updatedAt || (r.updatedAt === after.updatedAt && r.rfqId > after.rfqId))
      .sort((a, b) => a.updatedAt - b.updatedAt || compareCodeUnits(a.rfqId, b.rfqId))
      .slice(0, page.limit + 1);
    return pageResult(rows, page.limit, (r) => ({ updatedAt: r.updatedAt, rfqId: r.rfqId }));
  }

  saveRfqSwap(record: RfqSwapRecord): Promise<void> {
    return this.writes.run(async () => {
      const all = await this.getAllRfqSwaps();
      const at = all.findIndex((r) => r.rfqId === record.rfqId);
      if (at === -1) all.push(record);
      else all[at] = record;
      await this.store.set(this.key, all);
    });
  }

  removeRfqSwap(rfqId: string): Promise<void> {
    return this.writes.run(async () => {
      const all = await this.getAllRfqSwaps();
      await this.store.set(
        this.key,
        all.filter((r) => r.rfqId !== rfqId),
      );
    });
  }
}
