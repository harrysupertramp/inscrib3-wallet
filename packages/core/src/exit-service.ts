import {
  OnchainWallet,
  UnilateralExit,
  serializeExitPackage,
  deserializeExitPackage,
  type Wallet,
  type Identity,
  type OnchainProvider,
  type NetworkName,
  type ExitQuote,
  type ExecutorEvent,
} from '@arkade-os/sdk';
import type { KeyValueStore } from './key-value-store.js';

export interface SerializableExitProgress {
  events: ExecutorEvent[];
  done: boolean;
}

// One package per account and network: an exit can run for days, and
// switching network or account in the meantime must not lose it.
function exitPackageStorageKey(scope: string, network: string): string {
  const base = `arkade:exit:package:${network}`;
  return scope ? `${base}:${scope}` : base;
}

// Before packages were keyed by network: one per account, network inside.
function legacyExitPackageStorageKey(scope: string): string {
  return scope ? `arkade:exit:package:${scope}` : 'arkade:exit:package';
}

interface StoredExitPackage {
  network: string;
  serializedPackage: string;
}

// An exit can take hours to days (timelocks, confirmations), so each call
// runs for a bounded time and the UI keeps polling.
const EXIT_PROGRESS_BUDGET_MS = 10_000;

// Recovers VTXOs onchain without the Ark server, via their timelocked paths.
export class ExitService {
  private onchainWallet: OnchainWallet | null = null;
  private network: string | null = null;
  private scope: string | null = null;
  // Guards same-tab double calls; set before any await.
  private starting = false;
  private progressPromise: Promise<SerializableExitProgress> | null = null;

  constructor(private readonly store: KeyValueStore) {}

  async init(identity: Identity, network: NetworkName, onchainProvider: OnchainProvider, scope: string): Promise<void> {
    this.onchainWallet = await OnchainWallet.create(identity, network, onchainProvider);
    this.network = network;
    this.scope = scope;
  }

  dispose(): void {
    this.onchainWallet = null;
    this.network = null;
    this.scope = null;
  }

  private getOnchainWalletOrThrow(): OnchainWallet {
    if (!this.onchainWallet) throw new Error('Wallet is locked');
    return this.onchainWallet;
  }

  // Where the exit's CPFP fees come from: the SDK's onchain wallet, which is
  // the plain key-path address, not the boarding address.
  getFeeAddress(): string {
    return this.getOnchainWalletOrThrow().address;
  }

  // Locked (no network yet): nothing is pending, and nothing is touched.
  private async loadPendingForCurrentNetwork(): Promise<StoredExitPackage | null> {
    const network = this.network;
    if (!network) return null;
    const stored = await this.store.get<StoredExitPackage>(exitPackageStorageKey(this.scope ?? '', network));
    if (stored?.serializedPackage) return stored;
    return this.adoptLegacyPackage(network);
  }

  // A package under the old key moves to the new one once its own network is
  // active; until then it stays where it is.
  private async adoptLegacyPackage(network: string): Promise<StoredExitPackage | null> {
    const legacyKey = legacyExitPackageStorageKey(this.scope ?? '');
    const legacy = await this.store.get<StoredExitPackage>(legacyKey);
    if (!legacy?.serializedPackage || legacy.network !== network) return null;
    await this.store.set(exitPackageStorageKey(this.scope ?? '', network), legacy);
    await this.store.set(legacyKey, null);
    return legacy;
  }

  // 'graph' mode doesn't need the onchain wallet funded up front; it quotes
  // a funding address for fees.
  async estimate(wallet: Wallet, sweepAddress: string): Promise<ExitQuote> {
    return UnilateralExit.estimate({
      wallet,
      onchainWallet: this.getOnchainWalletOrThrow(),
      sweepAddress,
      mode: 'graph',
    });
  }

  async start(wallet: Wallet, sweepAddress: string): Promise<void> {
    if (this.starting) {
      throw new Error('A recovery is already in progress. Check its progress instead of starting another.');
    }
    this.starting = true;
    try {
      if (await this.hasPending()) {
        throw new Error('A recovery is already in progress. Check its progress instead of starting another.');
      }
      const onchainWallet = this.getOnchainWalletOrThrow();
      const network = this.network;
      if (!network) throw new Error('Wallet is locked');
      const pkg = await UnilateralExit.prepare({ wallet, onchainWallet, sweepAddress, mode: 'graph' });
      const toStore: StoredExitPackage = { network, serializedPackage: serializeExitPackage(pkg) };
      await this.store.set(exitPackageStorageKey(this.scope ?? '', network), toStore);
    } finally {
      this.starting = false;
    }
  }

  async hasPending(): Promise<boolean> {
    return (await this.loadPendingForCurrentNetwork()) !== null;
  }

  // Joins an in-flight call: the timeout race abandons iterator.next() instead
  // of cancelling it, so two Executors could otherwise run at once.
  async getProgress(): Promise<SerializableExitProgress> {
    if (this.progressPromise) return this.progressPromise;
    this.progressPromise = this._getProgress();
    try {
      return await this.progressPromise;
    } finally {
      this.progressPromise = null;
    }
  }

  private async _getProgress(): Promise<SerializableExitProgress> {
    const stored = await this.loadPendingForCurrentNetwork();
    if (!stored) throw new Error('No recovery in progress');
    const pkg = deserializeExitPackage(stored.serializedPackage);
    const onchainWallet = this.getOnchainWalletOrThrow();

    const executor = new UnilateralExit.Executor(pkg, onchainWallet.provider, { feeWallet: onchainWallet });

    const events: ExecutorEvent[] = [];
    const deadline = Date.now() + EXIT_PROGRESS_BUDGET_MS;
    const iterator = executor[Symbol.asyncIterator]();
    let iteratorDone = false;

    while (Date.now() < deadline) {
      const TIMED_OUT = Symbol('timed-out');
      const result = await Promise.race([
        iterator.next(),
        new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), deadline - Date.now())),
      ]);
      if (result === TIMED_OUT) break;
      if (result.done) {
        iteratorDone = true;
        break;
      }
      events.push(result.value);
    }

    if (iteratorDone) {
      await this.store.set(exitPackageStorageKey(this.scope ?? '', stored.network), null);
    }

    return { events, done: iteratorDone };
  }
}
