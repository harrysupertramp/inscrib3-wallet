import { describe, expect, setSystemTime, test } from 'bun:test';
import type { RfqSwapManager, LightningReceiveSwap, RfqSwap } from '@arkade-os/swap/protocol';
import type { Client as SatoraClient } from '@satora/swap';
import { LightningService } from './lightning-service.js';
import { inMemoryStore } from './test-helpers.js';

// init() talks to real providers, so tests inject duck-typed fakes into the
// private fields and cover this class's own guard, fallback and status logic.
function withFakeManager(service: LightningService, fake: Partial<RfqSwapManager>): void {
  (service as unknown as { manager: RfqSwapManager }).manager = fake as RfqSwapManager;
}

function withFakeSatora(service: LightningService, fake: Partial<SatoraClient>): void {
  (service as unknown as { satora: SatoraClient }).satora = fake as SatoraClient;
}

function withNetwork(service: LightningService, network: string): void {
  (service as unknown as { network: string }).network = network;
}

function withLatestSwap(service: LightningService, rfqId: string, swap: RfqSwap): void {
  (service as unknown as { latestByRfqId: Map<string, RfqSwap> }).latestByRfqId.set(rfqId, swap);
}

function withProvider(service: LightningService, id: string, provider: 'satora' | 'arkade'): void {
  (service as unknown as { providerById: Map<string, 'satora' | 'arkade'> }).providerById.set(id, provider);
}

function withScope(service: LightningService, scope: string): void {
  (service as unknown as { scope: string }).scope = scope;
}

function latestByRfqIdSize(service: LightningService): number {
  return (service as unknown as { latestByRfqId: Map<string, RfqSwap> }).latestByRfqId.size;
}

function providerByIdSize(service: LightningService): number {
  return (service as unknown as { providerById: Map<string, 'satora' | 'arkade'> }).providerById.size;
}

const baseReceiveSwap: LightningReceiveSwap = {
  kind: 'lightning_receive',
  rfqId: 'swap-1',
  state: 'pending',
  lockupPkScript: new Uint8Array(),
  paymentHash: 'hash',
  refundLocktime: 0,
  createdAt: 0,
  updatedAt: 0,
  expectedAmount: 1000,
};

describe('LightningService unavailable-state guards', () => {
  test('isAvailable() is false before init()', () => {
    const service = new LightningService(inMemoryStore());
    expect(service.isAvailable()).toBe(false);
  });

  test('createInvoice throws "Lightning is not available" when manager is null', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.createInvoice(1000)).rejects.toThrow(/Lightning is not available/);
  });

  test('createInvoice validates the amount before checking availability', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.createInvoice(-1)).rejects.toThrow(/Invalid amount/);
  });

  test('preparePayment throws "Lightning is not available" when manager is null', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.preparePayment('lnbc1...')).rejects.toThrow(/Lightning is not available/);
  });

  test('preparePayment validates the invoice string before checking availability', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.preparePayment('')).rejects.toThrow(/Invalid invoice/);
  });

  test('getInvoiceStatus throws "Lightning is not available" when manager is null', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.getInvoiceStatus('swap-1')).rejects.toThrow(/Lightning is not available/);
  });
});

describe('LightningService.isAvailable', () => {
  test('is true once the Arkade RFQ manager is set', () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    expect(service.isAvailable()).toBe(true);
  });

  test('is true once Satora alone is set, with no Arkade RFQ manager', () => {
    const service = new LightningService(inMemoryStore());
    withFakeSatora(service, {});
    expect(service.isAvailable()).toBe(true);
  });
});

describe('LightningService.getKnownTxids', () => {
  test('is empty when nothing has been recorded', async () => {
    const service = new LightningService(inMemoryStore());
    expect(await service.getKnownTxids()).toEqual(new Set());
  });

  test('is namespaced by network - a different network sees nothing', async () => {
    const store = inMemoryStore();
    await store.set('arkade:lightning:txids:mutinynet', ['tx-1']);
    const service = new LightningService(store);
    withNetwork(service, 'signet');
    expect(await service.getKnownTxids()).toEqual(new Set());
  });

  test('an empty scope uses the exact unsuffixed key existing installs already use', async () => {
    const store = inMemoryStore();
    await store.set('arkade:lightning:txids:mutinynet', ['tx-1']);
    const service = new LightningService(store);
    withNetwork(service, 'mutinynet');
    withScope(service, '');
    expect(await service.getKnownTxids()).toEqual(new Set(['tx-1']));
  });

  test('is namespaced by scope - a known txid for the default account is not visible to another one', async () => {
    const store = inMemoryStore();
    await store.set('arkade:lightning:txids:mutinynet', ['tx-1']);
    const service = new LightningService(store);
    withNetwork(service, 'mutinynet');
    withScope(service, '0-1');
    expect(await service.getKnownTxids()).toEqual(new Set());
  });
});

describe('LightningService.getInvoiceStatus', () => {
  test('reports "unknown" for a swapId RfqSwapManager never reported an update for', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    expect(await service.getInvoiceStatus('missing')).toEqual({ status: 'unknown', completed: false, failed: false });
  });

  test('reports not completed/not failed for a pending swap', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    withLatestSwap(service, 'swap-1', { ...baseReceiveSwap, state: 'pending' });
    expect(await service.getInvoiceStatus('swap-1')).toEqual({ status: 'pending', completed: false, failed: false });
  });

  test('reports failed for a refunded receive swap (the solver reclaimed an unclaimed lockup)', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    withLatestSwap(service, 'swap-1', { ...baseReceiveSwap, state: 'refunded' });
    const status = await service.getInvoiceStatus('swap-1');
    expect(status).toEqual({ status: 'refunded', completed: false, failed: true });
  });

  test('reports failed for a failed swap', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    withLatestSwap(service, 'swap-1', { ...baseReceiveSwap, state: 'failed', failure: 'boom' });
    const status = await service.getInvoiceStatus('swap-1');
    expect(status).toEqual({ status: 'failed', completed: false, failed: true });
  });

  test('reports completed and tags the claim txid for a settled receive swap', async () => {
    const service = new LightningService(inMemoryStore());
    withNetwork(service, 'mutinynet');
    withFakeManager(service, {});
    withLatestSwap(service, 'swap-1', { ...baseReceiveSwap, state: 'settled', claimTxid: 'tx-completed' });

    const status = await service.getInvoiceStatus('swap-1');
    expect(status).toEqual({ status: 'settled', completed: true, failed: false });
    expect(await service.getKnownTxids()).toEqual(new Set(['tx-completed']));
  });

  test('a settled swap with no claimTxid yet still reports completed, tagging nothing', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {});
    withLatestSwap(service, 'swap-1', { ...baseReceiveSwap, state: 'settled' });

    const status = await service.getInvoiceStatus('swap-1');
    expect(status.completed).toBe(true);
    expect(await service.getKnownTxids()).toEqual(new Set());
  });

  test('routes to Satora when the id was created there, ignoring any Arkade RFQ cache entry under the same id', async () => {
    const service = new LightningService(inMemoryStore());
    withProvider(service, 'satora-swap-1', 'satora');
    withFakeSatora(service, {
      getSwap: async () => ({ status: 'pending' }) as never,
    });
    const status = await service.getInvoiceStatus('satora-swap-1');
    expect(status).toEqual({ status: 'pending', completed: false, failed: false });
  });

  test('maps a Satora "clientredeemed" status to completed and tags its claim txid', async () => {
    const service = new LightningService(inMemoryStore());
    withNetwork(service, 'mutinynet');
    withProvider(service, 'satora-swap-1', 'satora');
    withFakeSatora(service, {
      getSwap: async () => ({ status: 'clientredeemed', arkade_claim_txid: 'tx-satora-claim' }) as never,
    });
    const status = await service.getInvoiceStatus('satora-swap-1');
    expect(status).toEqual({ status: 'clientredeemed', completed: true, failed: false });
    expect(await service.getKnownTxids()).toEqual(new Set(['tx-satora-claim']));
  });

  test('maps a Satora "expired" status to failed', async () => {
    const service = new LightningService(inMemoryStore());
    withProvider(service, 'satora-swap-1', 'satora');
    withFakeSatora(service, {
      getSwap: async () => ({ status: 'expired' }) as never,
    });
    const status = await service.getInvoiceStatus('satora-swap-1');
    expect(status).toEqual({ status: 'expired', completed: false, failed: true });
  });
});

describe('LightningService.dispose', () => {
  test('clears availability even when manager.stop() rejects', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {
      stop: async () => {
        throw new Error('solver unreachable');
      },
    });
    await service.dispose();
    expect(service.isAvailable()).toBe(false);
  });

  test('clears availability even when satora.stopTracking() throws', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeSatora(service, {
      stopTracking: () => {
        throw new Error('satora unreachable');
      },
    });
    await service.dispose();
    expect(service.isAvailable()).toBe(false);
  });

  test('clears both providers, one failing does not block the other from clearing', async () => {
    const service = new LightningService(inMemoryStore());
    withFakeManager(service, {
      stop: async () => {
        throw new Error('solver unreachable');
      },
    });
    withFakeSatora(service, { stopTracking: () => {} });
    await service.dispose();
    expect(service.isAvailable()).toBe(false);
  });

  test('is a no-op when never initialized', async () => {
    const service = new LightningService(inMemoryStore());
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  // Swap ids must not stay resolvable under the next account.
  test('clears latestByRfqId and providerById, not just the two providers', async () => {
    const service = new LightningService(inMemoryStore());
    withLatestSwap(service, 'swap-1', baseReceiveSwap);
    withProvider(service, 'swap-1', 'arkade');
    expect(latestByRfqIdSize(service)).toBe(1);
    expect(providerByIdSize(service)).toBe(1);

    await service.dispose();

    expect(latestByRfqIdSize(service)).toBe(0);
    expect(providerByIdSize(service)).toBe(0);
  });
});

// BOLT #11 spec test vector: 250,000 sats.
const INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

describe('LightningService prepare/confirm payment', () => {
  function serviceWithRfqQuote(fundAmount: number) {
    const service = new LightningService(inMemoryStore());
    const internals = service as unknown as Record<string, unknown>;
    withFakeManager(service, { stop: async () => undefined });
    internals.wallet = {};
    internals.arkServerUrl = 'https://ark.example';
    internals.requestArkadeRfqSend = async () => ({ rfqId: 'q1', fundAmount });
    const funded: unknown[] = [];
    internals.fundAndAwaitArkadeRfqSend = async (_m: unknown, _w: unknown, _i: unknown, request: unknown) => {
      funded.push(request);
      return { amount: fundAmount, preimage: 'p', txid: 't' };
    };
    return { service, funded };
  }

  test('prepare returns the full cost and moves no funds', async () => {
    const { service, funded } = serviceWithRfqQuote(250_900);
    const quote = await service.preparePayment(INVOICE);
    expect(quote).toEqual({ quoteId: 'q1', invoiceAmountSats: 250_000, feeSats: 900, totalSats: 250_900 });
    expect(funded).toEqual([]);
  });

  test('confirm funds the prepared quote exactly once', async () => {
    const { service, funded } = serviceWithRfqQuote(250_900);
    await service.preparePayment(INVOICE);
    expect(await service.confirmPayment('q1')).toMatchObject({ txid: 't' });
    expect(funded).toHaveLength(1);
    await expect(service.confirmPayment('q1')).rejects.toThrow(/LIGHTNING_QUOTE_EXPIRED/);
    expect(funded).toHaveLength(1);
  });

  test('an unknown or stale quote is refused', async () => {
    const { service, funded } = serviceWithRfqQuote(250_900);
    await expect(service.confirmPayment('nope')).rejects.toThrow(/LIGHTNING_QUOTE_EXPIRED/);
    await service.preparePayment(INVOICE);
    const prepared = (service as unknown as { preparedPayments: Map<string, { preparedAt: number }> }).preparedPayments;
    prepared.get('q1')!.preparedAt -= 3 * 60_000;
    await expect(service.confirmPayment('q1')).rejects.toThrow(/LIGHTNING_QUOTE_EXPIRED/);
    expect(funded).toEqual([]);
  });

  // Regression: a funded swap that refunded, failed or timed out returned like
  // a paid invoice.
  function fakeWallet() {
    return { send: async () => 'funding-txid' };
  }

  test('an Arkade RFQ send that ends refunded throws instead of reporting a payment', async () => {
    const service = new LightningService(inMemoryStore());
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitArkadeRfqSend.bind(service);
    const manager = { addSwap: async () => undefined, waitForSwapCompletion: async () => ({ state: 'refunded', txid: 'refund-txid' }) };
    const request = { rfqId: 'r1', address: 'ark1lockup', fundAmount: 1000, secrets: {}, paymentHash: 'aa', swapPkScript: new Uint8Array(), script: '', quote: { refund_locktime: 0 } };
    withScope(service, '');
    await expect(fund(manager, fakeWallet(), {}, request)).rejects.toThrow(/LIGHTNING_PAYMENT_FAILED.*refunded/);
  });

  test('a Satora send that ends in a failed status throws', async () => {
    const service = new LightningService(inMemoryStore());
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitSatoraSend.bind(service);
    const satora = { getSwap: async () => ({ status: 'expired' }) };
    await expect(fund(satora, fakeWallet(), { id: 's1', arkade_vhtlc_address: 'ark1vhtlc' }, 1000)).rejects.toThrow(/LIGHTNING_PAYMENT_FAILED.*expired/);
  });

  test('a Satora send still unsettled at the deadline throws as pending, not paid', async () => {
    const service = new LightningService(inMemoryStore());
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitSatoraSend.bind(service);
    // Each poll jumps the clock past the 5-minute wait, so the loop ends after one 3 s pause.
    const satora = {
      getSwap: async () => {
        setSystemTime(new Date(Date.now() + 6 * 60_000));
        return { status: 'pending' };
      },
    };
    try {
      await expect(fund(satora, fakeWallet(), { id: 's1', arkade_vhtlc_address: 'ark1vhtlc' }, 1000)).rejects.toThrow(/LIGHTNING_PAYMENT_PENDING/);
    } finally {
      setSystemTime();
    }
  }, 10_000);

  test('a Satora send that settles still returns its claim txid', async () => {
    const service = new LightningService(inMemoryStore());
    withScope(service, '');
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitSatoraSend.bind(service);
    const satora = { getSwap: async () => ({ status: 'clientredeemed', arkade_claim_txid: 'claim-txid' }) };
    expect(await fund(satora, fakeWallet(), { id: 's1', arkade_vhtlc_address: 'ark1vhtlc' }, 1000)).toEqual({ amount: 1000, preimage: '', txid: 'claim-txid' });
  });

  // Regression: sends tagged the provider's claim txid, which never appears in
  // this wallet's history, so a paid invoice showed up in Activity as an Ark send.
  test('a Satora send tags its own funding tx as Lightning', async () => {
    const service = new LightningService(inMemoryStore());
    withScope(service, '');
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitSatoraSend.bind(service);
    const satora = { getSwap: async () => ({ status: 'clientredeemed', arkade_claim_txid: 'claim-txid' }) };
    await fund(satora, fakeWallet(), { id: 's1', arkade_vhtlc_address: 'ark1vhtlc' }, 1000);
    expect(await service.getKnownTxids()).toEqual(new Set(['funding-txid']));
  });

  test('an Arkade RFQ send tags its own funding tx as Lightning', async () => {
    const service = new LightningService(inMemoryStore());
    withScope(service, '');
    const fund = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).fundAndAwaitArkadeRfqSend.bind(service);
    const manager = { addSwap: async () => undefined, waitForSwapCompletion: async () => ({ state: 'failed' }) };
    const request = { rfqId: 'r1', address: 'ark1lockup', fundAmount: 1000, secrets: {}, paymentHash: 'aa', swapPkScript: new Uint8Array(), script: '', quote: { refund_locktime: 0 } };
    await expect(fund(manager, fakeWallet(), {}, request)).rejects.toThrow(/LIGHTNING_PAYMENT_FAILED/);
    expect(await service.getKnownTxids()).toEqual(new Set(['funding-txid']));
  });

  test('dispose discards prepared quotes', async () => {
    const { service } = serviceWithRfqQuote(250_900);
    await service.preparePayment(INVOICE);
    await service.dispose();
    await expect(service.confirmPayment('q1')).rejects.toThrow(/LIGHTNING_QUOTE_EXPIRED/);
  });
});

describe('LightningService network gating', () => {
  async function initWith(isMainnet: boolean): Promise<boolean> {
    const service = new LightningService(inMemoryStore());
    let started = 0;
    const internals = service as unknown as Record<string, unknown>;
    internals.initSatora = async () => void started++;
    internals.initArkadeRfq = async () => void started++;
    const networkInfo = { network: 'x', displayName: 'X', isTestnet: !isMainnet, arkServerUrl: 'u', esploraUrl: 'e' };
    await service.init({} as never, networkInfo, {} as never, {} as never, 'pw', '', isMainnet);
    return started === 2;
  }

  // Both providers are mainnet-only; Satora's API rejects testnet addresses.
  test('providers only start on mainnet', async () => {
    expect(await initWith(true)).toBe(true);
    expect(await initWith(false)).toBe(false);
  });
});
