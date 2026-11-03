import {
  Wallet,
  MnemonicIdentity,
  RestArkProvider,
  RestIndexerProvider,
  EsploraProvider,
  Ramps,
  onchainRail,
  walletFeeSource,
  Estimator,
  toOffchainInputFeeParams,
  type FeeInfo,
  type NormalizedExtendedVirtualCoin,
  BIP322,
  OnchainWallet,
  getNetwork,
  isRetryableProviderError,
  type IWallet,
  type IntentRepository,
  type ArkProvider,
  type WalletBalance,
  type NetworkName,
  type ExtendedVirtualCoin,
  type Identity,
  type SettlementEvent,
  SettlementEventType,
} from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { generateMnemonic as bip39Generate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { KeyValueStore } from './key-value-store.js';
import {
  encryptMnemonic,
  decryptMnemonic,
  saveEncryptedMnemonic,
  loadEncryptedMnemonic,
  hasStoredWallet,
} from './session.js';
import { createStorageConfig } from './storage.js';
import { releaseStaleIntents, reservedAsset, unfinishedIntents } from './intent-recovery.js';
import { loadNetworkSettings, describeNetwork, getDelegateUrl } from './network-settings.js';
import { createCachingDelegateProvider } from './delegate-provider.js';
import { LightningService, type LightningPaymentQuote } from './lightning-service.js';
import { IncomingFundsFilter, type IncomingFundsSummary } from './incoming-funds.js';
import { ExitService, type SerializableExitProgress } from './exit-service.js';
import { AssetService, type AssetInfo } from './asset-service.js';
import { toHistoryEntry, type TxHistoryEntry } from './tx-history.js';
import { accountKeyPath, deriveAccountDescriptor } from './account-derivation.js';
import {
  loadAccounts,
  saveAccounts,
  loadActiveAccount,
  saveActiveAccount,
  accountScopeKey,
  type AccountInfo,
  type ActiveAccount,
} from './accounts.js';
import {
  assertValidAddress,
  assertValidAmount,
  assertValidPassword,
  assertValidVtxoOutpoint,
  assertValidMnemonic,
  normalizeMnemonic,
} from './validation.js';

export type { SerializableExitProgress } from './exit-service.js';
export type { TxHistoryEntry } from './tx-history.js';
export type { AssetInfo } from './asset-service.js';
export type { LightningPaymentQuote } from './lightning-service.js';
export type { IncomingFundsSummary } from './incoming-funds.js';

export type { AccountInfo, ActiveAccount } from './accounts.js';

// assets[].amount is a number here: bigint can't cross extension messaging.
export interface SerializableWalletBalance extends Omit<WalletBalance, 'assets' | 'availableAssets'> {
  assets: Array<{ assetId: string; amount: number }>;
  availableAssets: Array<{ assetId: string; amount: number }>;
}

// SDK asset amounts are bigint, which extension messaging can't carry.
function toSerializableAssets(assets: ReadonlyArray<{ assetId: string; amount: bigint }>) {
  return assets.map((a) => ({ assetId: a.assetId, amount: Number(a.amount) }));
}

export interface SerializableVtxo {
  txid: string;
  vout: number;
  value: number;
  status: 'preconfirmed' | 'settled';
  createdAt: number; // unix seconds
  // Unix seconds: the coin's batch expiry, after which the server may sweep it.
  // Settling before then renews it into a new batch.
  expiresAt?: number;
  // Past expiry and swept: the coin is still yours, recoverable by settling.
  swept: boolean;
  assetIds: string[];
  // L1 commitment txid that settled this VTXO; `txid` is the offchain Ark tx.
  settledTxid?: string;
}

// Re-resolved against a fresh getSpendableVtxos() before funds move, so a
// stale selection can't spend an already-spent or locked outpoint.
export interface VtxoOutpoint {
  txid: string;
  vout: number;
}

// Only what the progress log shows: raw SDK events carry bigints and
// transaction trees, which extension messaging can't carry.
export interface SettleProgressEvent {
  type: SettlementEvent['type'];
  reason?: string;
}

export interface SerializableSettleProgress {
  events: SettleProgressEvent[];
  done: boolean;
  txid?: string;
  error?: string;
}

// BIP-322 signs for the key-path P2TR of the wallet key, not the Ark or
// boarding address, so that is the address a verifier must use.
export interface SignedMessage {
  message: string;
  signature: string;
  address: string;
}

export interface OnchainSendQuote {
  amount: number; // what the receiver gets
  fee: number;
  total: number; // what leaves the wallet
}

// Offboard spends every spendable VTXO; one carrying an asset gets the whole
// batch rejected, since an asset can't go to an onchain output. Leaving those
// out keeps the assets (and the sats under them) offchain.
function withoutAssetVtxos(wallet: Wallet): Wallet {
  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === 'getSpendableVtxos') {
        return async (...args: Parameters<Wallet['getSpendableVtxos']>) =>
          (await target.getSpendableVtxos(...args)).filter((v) => !v.assets?.length);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// The VTXOs an offboard spends, picked like the SDK's Ramps does: asset-free
// (withoutAssetVtxos), and worth more than the input fee to spend them.
async function exitCandidates(
  wallet: Wallet,
  fees: FeeInfo,
): Promise<{ exitInputs: NormalizedExtendedVirtualCoin[]; underAssets: number }> {
  const estimator = new Estimator(fees.intentFee ?? {});
  const spendable = await wallet.getSpendableVtxos({ withRecoverable: true, withUnrolled: false, genericallySpendableOnly: true });
  const exitInputs: NormalizedExtendedVirtualCoin[] = [];
  let underAssets = 0;
  for (const v of spendable) {
    if (v.assets?.length) underAssets += v.value;
    else if (estimator.evalOffchainInput(toOffchainInputFeeParams(v)).satoshis < v.value) exitInputs.push(v);
  }
  return { exitInputs, underAssets };
}

const RESOLVED_NETWORK_STORAGE_KEY = 'arkade:network:resolved';
interface ResolvedNetworkCache {
  arkServerUrl: string;
  network: string;
}

export class WalletManager {
  private wallet: IWallet | null = null;
  private network: string | null = null;
  private seedId: number | null = null;
  private accountIndex: number | null = null;
  // Only the password is cached while unlocked, so account switches don't
  // re-prompt. Mnemonics are decrypted on demand and never kept.
  private password: string | null = null;
  private initializing = false;
  private readonly lightning: LightningService;
  private readonly exit: ExitService;
  private readonly assets = new AssetService();
  private settling = false;
  private intentRepository: IntentRepository | null = null;
  private arkProvider: Pick<ArkProvider, 'deleteIntent'> | null = null;
  private settleState: SerializableSettleProgress | null = null;

  constructor(private readonly store: KeyValueStore) {
    this.lightning = new LightningService(store);
    this.exit = new ExitService(store);
  }

  isUnlocked(): boolean {
    return this.wallet !== null;
  }

  async isCreated(): Promise<boolean> {
    return hasStoredWallet(this.store);
  }

  private getWalletOrThrow(): IWallet {
    if (!this.wallet) throw new Error('Wallet is locked');
    return this.wallet;
  }

  async create(rawMnemonic: string, password: string): Promise<void> {
    assertValidPassword(password);
    // Never overwrite an existing seed: if the UI misreads state and shows
    // setup, creating must not destroy the real wallet.
    if (await this.isCreated()) throw new Error('A wallet already exists on this device');
    // Validated before anything is stored: a stored invalid phrase can never
    // unlock, and there is no way back to setup from the unlock screen.
    const mnemonic = normalizeMnemonic(rawMnemonic);
    assertValidMnemonic(mnemonic);
    const encrypted = await encryptMnemonic(mnemonic, password);
    await saveEncryptedMnemonic(this.store, encrypted, 0);
    // restore() shares this path: a new seed must never inherit a previous
    // wallet's accounts.
    await saveAccounts(this.store, [{ seedId: 0, index: 0, label: 'Account 1' }]);
    await saveActiveAccount(this.store, { seedId: 0, index: 0 });
    await this._initWallet(mnemonic, password, 0, 0);
  }

  async restore(mnemonic: string, password: string): Promise<void> {
    return this.create(mnemonic, password);
  }

  // Errors cross the extension boundary as strings, so the UI matches on this
  // prefix to tell a wrong password from other failures.
  private async _decryptSeedOrThrow(seedId: number, password: string): Promise<string> {
    const payload = await loadEncryptedMnemonic(this.store, seedId);
    if (!payload) throw new Error('No wallet found');
    try {
      return await decryptMnemonic(payload, password);
    } catch {
      throw new Error('INCORRECT_PASSWORD');
    }
  }

  async unlock(password: string): Promise<void> {
    const active = await this._resolveActiveAccountOrDefault();
    const mnemonic = await this._decryptSeedOrThrow(active.seedId, password);
    try {
      await this._initWallet(mnemonic, password, active.seedId, active.index);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
  }

  // A stale active-account pointer would otherwise block unlock forever: the
  // account switcher is only reachable after unlocking.
  private async _resolveActiveAccountOrDefault(): Promise<ActiveAccount> {
    const active = await loadActiveAccount(this.store);
    const accounts = await loadAccounts(this.store);
    if (accounts.some((a) => a.seedId === active.seedId && a.index === active.index)) {
      return active;
    }
    const fallback: ActiveAccount = { seedId: 0, index: 0 };
    await saveActiveAccount(this.store, fallback);
    return fallback;
  }

  // Reachable from the locked screen, without a password: recovers from an
  // account that fails to initialize.
  async resetToPrimaryAccount(): Promise<void> {
    await saveActiveAccount(this.store, { seedId: 0, index: 0 });
  }

  // Re-initializes the active account against the current network settings
  // with the cached password, so a network switch doesn't re-prompt. On
  // failure the wallet ends up locked (see _initWallet).
  async reconnect(): Promise<void> {
    const password = this.requirePassword();
    const seedId = this.seedId ?? 0;
    const accountIndex = this.accountIndex ?? 0;
    const mnemonic = await this._decryptSeedOrThrow(seedId, password);
    try {
      await this._initWallet(mnemonic, password, seedId, accountIndex);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
  }

  // Exports the active seed only; switch accounts to export another.
  async exportMnemonic(password: string): Promise<string> {
    const active = await loadActiveAccount(this.store);
    return this._decryptSeedOrThrow(active.seedId, password);
  }

  // wallet.clear() disposes the SDK wallet, so it has to be re-initialized,
  // which needs the password again.
  async resetLocalCache(password: string): Promise<void> {
    const wallet = this.getWalletOrThrow();
    const seedId = this.seedId ?? 0;
    const accountIndex = this.accountIndex ?? 0;
    const mnemonic = await this._decryptSeedOrThrow(seedId, password);

    await wallet.clear();
    try {
      await this._initWallet(mnemonic, password, seedId, accountIndex);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
  }

  // Listeners survive lock/unlock; only the underlying watcher restarts.
  onIncomingFunds(callback: (funds: IncomingFundsSummary) => void): () => void {
    this.fundsListeners.add(callback);
    return () => this.fundsListeners.delete(callback);
  }

  // Held while unlocked so signMessage() can reach the key.
  private identity: Identity | null = null;
  private signingAddress: string | null = null;

  private readonly fundsListeners = new Set<(funds: IncomingFundsSummary) => void>();
  // One live subscription while unlocked; replaced on every re-init.
  private fundsWatch: { filter: IncomingFundsFilter; stop: () => void } | null = null;

  private startIncomingFundsWatch(wallet: Wallet): void {
    this.stopIncomingFundsWatch();
    const filter = new IncomingFundsFilter((summary) => {
      for (const listener of this.fundsListeners) {
        try {
          listener(summary);
        } catch {
          // one bad listener must not kill the watch
        }
      }
    });
    const watch = { filter, stop: () => filter.dispose() };
    this.fundsWatch = watch;
    this.subscribeIncomingFunds(wallet, watch);
  }

  // A failed subscribe (the server briefly down at unlock) is retried until it
  // works or a newer watch replaces this one.
  private subscribeIncomingFunds(wallet: Wallet, watch: { filter: IncomingFundsFilter; stop: () => void }): void {
    wallet
      .notifyIncomingFunds((funds) => watch.filter.handle(funds))
      .then((stop) => {
        if (this.fundsWatch !== watch) return stop(); // superseded while subscribing
        watch.stop = () => {
          stop();
          watch.filter.dispose();
        };
      })
      .catch(() => {
        if (this.fundsWatch !== watch) return;
        const retry = setTimeout(() => {
          if (this.fundsWatch === watch) this.subscribeIncomingFunds(wallet, watch);
        }, WalletManager.FUNDS_WATCH_RETRY_MS);
        watch.stop = () => {
          clearTimeout(retry);
          watch.filter.dispose();
        };
      });
  }

  private stopIncomingFundsWatch(): void {
    this.fundsWatch?.stop();
    this.fundsWatch = null;
  }

  // Marks a tx we created, so the VTXOs it returns to us aren't announced as received.
  private ownTx(txid: string): string {
    this.fundsWatch?.filter.markOwnTx(txid);
    return txid;
  }

  async signMessage(message: string): Promise<SignedMessage> {
    const identity = this.identity;
    const networkName = this.network;
    if (!identity || !networkName) throw new Error('Wallet is locked');
    const signature = await BIP322.sign(message, identity, getNetwork(networkName as NetworkName));
    return { message, signature, address: await this._signingAddress(identity, networkName) };
  }

  private async _signingAddress(identity: Identity, networkName: string): Promise<string> {
    if (!this.signingAddress) {
      const onchain = await OnchainWallet.create(identity, networkName as NetworkName);
      this.signingAddress = onchain.address;
    }
    return this.signingAddress;
  }

  async lock(): Promise<void> {
    this.identity = null;
    this.signingAddress = null;
    this.stopIncomingFundsWatch();
    await this.lightning.dispose();
    this.exit.dispose();
    this.network = null;
    this.seedId = null;
    this.accountIndex = null;
    this.settleState = null;
    this.password = null;
    if (this.wallet) {
      try {
        // dispose() can hang on an unhealthy websocket; locking must not block on it.
        await Promise.race([
          (this.wallet as Wallet).dispose?.(),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      } catch {
        // best-effort
      }
      this.wallet = null;
    }
  }

  async getAddress(): Promise<string> {
    return this.getWalletOrThrow().getAddress();
  }

  // The raw (untweaked) x-only key, for dApps that build their own scripts
  // naming this wallet; getAddress() only exposes the tweaked output key.
  async getXOnlyPublicKey(): Promise<string> {
    this.getWalletOrThrow();
    if (!this.identity) throw new Error('Wallet is locked');
    return hex.encode(await this.identity.xOnlyPublicKey());
  }

  async getBoardingAddress(): Promise<string> {
    return this.getWalletOrThrow().getBoardingAddress();
  }

  async getBalance(): Promise<SerializableWalletBalance> {
    const balance = await this.getWalletOrThrow().getBalance();
    return {
      ...balance,
      assets: toSerializableAssets(balance.assets),
      availableAssets: toSerializableAssets(balance.availableAssets ?? []),
    };
  }

  private static toSerializableVtxo(v: Awaited<ReturnType<IWallet['getVtxos']>>[number]): SerializableVtxo {
    return {
      txid: v.txid,
      vout: v.vout,
      value: v.value,
      status: v.isPreconfirmed ? 'preconfirmed' : 'settled',
      createdAt: Math.floor(v.createdAt.getTime() / 1000),
      expiresAt: v.expiresAt ? Math.floor(v.expiresAt.getTime() / 1000) : undefined,
      swept: v.isSwept ?? false,
      assetIds: (v.assets ?? []).map((a) => a.assetId),
      settledTxid: v.isPreconfirmed ? undefined : v.settledBy,
    };
  }

  async getVtxos(): Promise<SerializableVtxo[]> {
    const vtxos = await this.getWalletOrThrow().getVtxos();
    return vtxos.map(WalletManager.toSerializableVtxo);
  }

  // Excludes VTXOs locked in an in-flight intent - the right source for coin control.
  async getSpendableVtxos(): Promise<SerializableVtxo[]> {
    const vtxos = await this.getWalletOrThrow().getSpendableVtxos();
    return vtxos.map(WalletManager.toSerializableVtxo);
  }

  private async resolveSelectedVtxos(selection?: VtxoOutpoint[]): Promise<ExtendedVirtualCoin[] | undefined> {
    if (!selection || selection.length === 0) return undefined;
    for (const ref of selection) assertValidVtxoOutpoint(ref);
    const spendable = await this.getWalletOrThrow().getSpendableVtxos();
    const byKey = new Map(spendable.map((v) => [`${v.txid}:${v.vout}`, v]));
    const resolved: ExtendedVirtualCoin[] = [];
    const missing: string[] = [];
    for (const ref of selection) {
      const match = byKey.get(`${ref.txid}:${ref.vout}`);
      if (!match) {
        missing.push(`${ref.txid}:${ref.vout}`);
        continue;
      }
      resolved.push(match);
    }
    if (missing.length > 0) {
      throw new Error(`SELECTED_VTXOS_NO_LONGER_SPENDABLE: ${missing.join(',')}`);
    }
    return resolved;
  }

  generateMnemonic(): string {
    return bip39Generate(wordlist, 128); // 12 words
  }

  async send(address: string, amount: number, selectedVtxos?: VtxoOutpoint[]): Promise<string> {
    assertValidAddress(address);
    assertValidAmount(amount);
    const resolved = await this.resolveSelectedVtxos(selectedVtxos);
    return this.ownTx(
      await this.getWalletOrThrow().send({
        recipients: [{ address, amount }],
        ...(resolved ? { selectedVtxos: resolved } : {}),
      }),
    );
  }

  async sendAsset(
    address: string,
    assets: Array<{ assetId: string; amount: number }>,
    bitcoinAmount?: number,
    selectedVtxos?: VtxoOutpoint[],
  ): Promise<string> {
    assertValidAddress(address);
    if (assets.length === 0) throw new Error('At least one asset is required');
    for (const a of assets) {
      assertValidAddress(a.assetId, 'assetId');
      assertValidAmount(a.amount, 'asset amount');
    }
    if (bitcoinAmount !== undefined) assertValidAmount(bitcoinAmount, 'bitcoinAmount');
    for (const a of assets) await this._assertAssetNotReserved(a.assetId, String(a.amount));
    const resolved = await this.resolveSelectedVtxos(selectedVtxos);
    const txid = await this.getWalletOrThrow().send({
      recipients: [{
        address,
        assets: assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })),
        ...(bitcoinAmount !== undefined ? { amount: bitcoinAmount } : {}),
      }],
      ...(resolved ? { selectedVtxos: resolved } : {}),
    });
    return this.ownTx(txid);
  }

  // Settle and offboard include every VTXO as an input, so one VTXO near expiry
  // can get the whole request rejected (minExpiryGap). The prefix lets the UI
  // explain that.
  private static rethrowExpiryGapError(e: unknown): never {
    const msg = String(e);
    if (msg.includes('minExpiryGap') || msg.includes('INVALID_PSBT_INPUT')) {
      throw new Error(`BLOCKED_BY_EXPIRING_VTXO: ${msg}`);
    }
    throw e instanceof Error ? e : new Error(msg);
  }

  isSettling(): boolean {
    return this.settling;
  }

  async settle(): Promise<string> {
    if (this.settling) {
      throw new Error('A settlement is already in progress. Check its progress instead of starting another.');
    }
    this.settling = true;
    const state: SerializableSettleProgress = { events: [], done: false };
    this.settleState = state;
    try {
      const txid = await (this.getWalletOrThrow() as Wallet).settle(undefined, (event) => {
        state.events.push(event.type === SettlementEventType.BatchFailed ? { type: event.type, reason: event.reason } : { type: event.type });
      });
      state.done = true;
      state.txid = txid;
      return this.ownTx(txid);
    } catch (e: unknown) {
      state.done = true;
      state.error = String(e);
      WalletManager.rethrowExpiryGapError(e);
    } finally {
      this.settling = false;
    }
  }

  async getSettleProgress(): Promise<SerializableSettleProgress> {
    if (!this.settleState) return { events: [], done: true };
    return { ...this.settleState, events: [...this.settleState.events] };
  }

  // The exit fee is added on top, so the receiver gets exactly `amount`; the
  // same quote the SDK's own payment router (onchainRail) makes.
  async quoteOnchainSend(destinationAddress: string, amount: number): Promise<OnchainSendQuote> {
    assertValidAddress(destinationAddress);
    assertValidAmount(amount);
    const wallet = this.getWalletOrThrow() as Wallet;
    const fees = await walletFeeSource(wallet)();
    const { exitInputs, underAssets } = await exitCandidates(wallet, fees);
    // Quoting the exact inputs the offboard will spend adds their input fees
    // and the change output's fee, not just the onchain output's.
    const quote = await onchainRail({ feeInfo: async () => fees }).quote(
      { raw: destinationAddress, amount, selectedVtxos: exitInputs },
      { wallet, prefs: {} },
    );
    const free = exitInputs.reduce((sum, v) => sum + v.value, 0);
    if (quote.total > free) {
      const shortfall = `Not enough to exit: this needs ${quote.total} sats (${quote.amount} + ${quote.fee} fee), and only ${free} sats can leave Arkade.`;
      throw new Error(
        quote.total <= free + underAssets
          ? `${shortfall} Another ${underAssets} sats sit in VTXOs that also carry an asset, and an asset can't exit onchain. ` +
              'Send the full amount of each asset to your own Ark address first (Assets tab, Max): the leftover sats come back as a separate VTXO you can exit.'
          : shortfall,
      );
    }
    const change = free - quote.total;
    if (change > 0 && change < Number(wallet.dustAmount)) {
      throw new Error(
        `This would leave ${change} sats of change, below the ${wallet.dustAmount}-sat minimum the server accepts. ` +
          `Add ${change} sats to the amount (or use Max) to exit everything, or send less so at least ${wallet.dustAmount} sats stay.`,
      );
    }
    return { amount: quote.amount, fee: quote.fee, total: quote.total };
  }

  // Collaborative exit to an onchain address. With an amount, the receiver
  // gets exactly that and the exit fee is added on top; without one,
  // everything is offboarded and the fee comes out of it.
  async sendOnchain(destinationAddress: string, amount?: number): Promise<string> {
    assertValidAddress(destinationAddress);
    if (amount !== undefined) assertValidAmount(amount);
    const wallet = this.getWalletOrThrow() as Wallet;
    const { fees: feeInfo } = await wallet.arkProvider.getInfo();
    const spendable = await wallet.getSpendableVtxos();
    if (spendable.length > 0 && spendable.every((v) => v.assets?.length)) {
      throw new Error(
        'All your spendable sats sit in VTXOs that also carry an asset, and an asset cannot exit onchain. ' +
          'Send the full amount of each asset to your own Ark address first (Assets tab, Max): the leftover sats come back as a separate VTXO you can exit.',
      );
    }
    // Run for its clear errors (asset-locked sats, not enough to cover the fee).
    if (amount !== undefined) await this.quoteOnchainSend(destinationAddress, amount);
    const ramps = new Ramps(withoutAssetVtxos(wallet));
    try {
      const txid =
        amount !== undefined
          ? await ramps.offboardExact({ destinationAddress, feeInfo, amount: BigInt(amount) })
          : await ramps.offboard(destinationAddress, feeInfo);
      return this.ownTx(txid);
    } catch (e: unknown) {
      WalletManager.rethrowExpiryGapError(e);
    }
  }

  private static readonly FUNDS_WATCH_RETRY_MS = 5_000;

  // Ark, boarding and Lightning.
  async getTransactionHistory(): Promise<TxHistoryEntry[]> {
    const [txs, lightningTxids] = await Promise.all([
      this.getWalletOrThrow().getTransactionHistory(),
      this.lightning.getKnownTxids(),
    ]);
    return txs.map((tx) => toHistoryEntry(tx, lightningTxids));
  }

  async getAssetTransactionHistory(assetId: string): Promise<TxHistoryEntry[]> {
    const lightningTxids = await this.lightning.getKnownTxids();
    return this.assets.getTransactionHistory(this.getWalletOrThrow(), assetId, lightningTxids);
  }

  // --- Unilateral exit ---
  async getExitFeeAddress(): Promise<string> {
    return this.exit.getFeeAddress();
  }

  async estimateExit(sweepAddress: string) {
    assertValidAddress(sweepAddress, 'sweepAddress');
    return this.exit.estimate(this.getWalletOrThrow() as Wallet, sweepAddress);
  }

  async startExit(sweepAddress: string): Promise<void> {
    assertValidAddress(sweepAddress, 'sweepAddress');
    return this.exit.start(this.getWalletOrThrow() as Wallet, sweepAddress);
  }

  async hasPendingExit(): Promise<boolean> {
    return this.exit.hasPending();
  }

  async getExitProgress(): Promise<SerializableExitProgress> {
    return this.exit.getProgress();
  }

  // --- Lightning ---
  isLightningAvailable(): boolean {
    return this.lightning.isAvailable();
  }

  async createLightningInvoice(amountSats: number) {
    return this.lightning.createInvoice(amountSats);
  }

  async prepareLightningPayment(invoice: string): Promise<LightningPaymentQuote> {
    return this.lightning.preparePayment(invoice);
  }

  async confirmLightningPayment(quoteId: string) {
    return this.lightning.confirmPayment(quoteId);
  }

  async getLightningInvoiceStatus(swapId: string) {
    return this.lightning.getInvoiceStatus(swapId);
  }

  // --- Assets ---
  async getAssets(): Promise<AssetInfo[]> {
    return this.assets.getAssets(this.getWalletOrThrow());
  }

  // Also resolves assets no longer held, e.g. for history entries.
  async getAssetMetadata(assetId: string): Promise<AssetInfo['metadata']> {
    return this.assets.getAssetMetadata(this.getWalletOrThrow(), assetId);
  }

  // A cached network name is only used for the exact same server URL.
  private async resolveNetwork(arkProvider: RestArkProvider, arkServerUrl: string): Promise<string> {
    try {
      const { network } = await arkProvider.getInfo();
      await this.store.set(RESOLVED_NETWORK_STORAGE_KEY, { arkServerUrl, network } satisfies ResolvedNetworkCache);
      return network;
    } catch (e) {
      if (!isRetryableProviderError(e)) throw e;
      const cached = await this.store.get<ResolvedNetworkCache>(RESOLVED_NETWORK_STORAGE_KEY);
      if (!cached || cached.arkServerUrl !== arkServerUrl) throw e;
      return cached.network;
    }
  }

  private async _initWallet(mnemonic: string, password: string, seedId: number, accountIndex: number): Promise<void> {
    // Set before any await so two concurrent inits can't both get through.
    if (this.initializing) {
      throw new Error('Wallet initialization already in progress');
    }
    this.initializing = true;
    try {
      await this._doInitWallet(mnemonic, password, seedId, accountIndex);
    } catch (e) {
      // Never leave a half-built session that reports unlocked.
      await this.lock();
      throw e;
    } finally {
      this.initializing = false;
    }
  }

  private async _doInitWallet(mnemonic: string, password: string, seedId: number, accountIndex: number): Promise<void> {
    if (this.wallet) {
      await this.lock();
    }

    const { arkServerUrl, esploraUrl } = await loadNetworkSettings(this.store);
    const arkProvider = new RestArkProvider(arkServerUrl);
    const network = await this.resolveNetwork(arkProvider, arkServerUrl);
    this.network = network;
    this.seedId = seedId;
    this.accountIndex = accountIndex;
    const isMainnet = network === 'bitcoin';
    // Account 0 keeps the SDK's default derivation that existing funds rely on;
    // higher accounts use an explicit BIP86 descriptor.
    const identity =
      accountIndex === 0
        ? MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet })
        : MnemonicIdentity.fromMnemonic(mnemonic, {
            descriptor: deriveAccountDescriptor(mnemonic, isMainnet, accountIndex),
          });

    const indexerProvider = new RestIndexerProvider(arkServerUrl);
    const onchainProvider = new EsploraProvider(esploraUrl);
    const scope = accountScopeKey(seedId, accountIndex);

    // The delegate adds a third tapleaf (user + delegate + server), which changes
    // the offchain address. The SDK keeps watching the 2-leaf address too. Only
    // presets have a delegate; custom servers stay on 2 leaves.
    const delegateUrl = getDelegateUrl(arkServerUrl);

    const storage = createStorageConfig(network, scope);
    this.wallet = await Wallet.create({
      identity,
      arkProvider,
      indexerProvider,
      onchainProvider,
      ...(delegateUrl
        ? { delegateProvider: createCachingDelegateProvider(delegateUrl, this.store) }
        : {}),
      storage,
    });
    this.intentRepository = storage.intentRepository ?? null;
    this.arkProvider = arkProvider;
    this.password = password;
    // Coins held by a settle that died with the last session (O-12).
    void this.releaseStaleSettlements().catch(() => undefined);

    await this.exit.init(identity, network as NetworkName, onchainProvider, scope);

    this.identity = identity;
    this.signingAddress = null;
    this.startIncomingFundsWatch(this.wallet as Wallet);

    const networkInfo = describeNetwork(await loadNetworkSettings(this.store));
    await this.lightning.init(this.wallet, networkInfo, arkProvider, indexerProvider, password, scope, isMainnet);
  }

  /** Cancels settlement intents that stopped making progress, freeing their coins. */
  async releaseStaleSettlements(): Promise<number> {
    if (!this.intentRepository || !this.arkProvider || this.settling) return 0;
    return releaseStaleIntents(this.intentRepository, this.arkProvider, Date.now());
  }

  // "have 0" while the balance shows the asset means a settlement holds it:
  // free a stalled one, and if a live one still holds it, say that instead.
  private async _assertAssetNotReserved(assetId: unknown, amount: unknown): Promise<void> {
    if (!this.intentRepository || typeof assetId !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount)) return;
    const wallet = this.getWalletOrThrow();
    await this.releaseStaleSettlements().catch(() => 0);
    const intents = await unfinishedIntents(this.intentRepository);
    if (intents.length === 0) return;
    const needed = BigInt(amount);
    let spendable = 0n;
    for (const v of await wallet.getSpendableVtxos()) for (const a of v.assets ?? []) if (a.assetId === assetId) spendable += a.amount;
    if (spendable >= needed) return;
    const reserved = reservedAsset(intents, await wallet.getVtxos(), assetId);
    if (reserved.amount === 0n || spendable + reserved.amount < needed) return;
    throw new Error(
      `${reserved.amount} units of this asset are held by a settlement that hasn't finished, so only ${spendable} can be spent now. The wallet frees a stalled settlement after 15 minutes - try again after ${new Date(reserved.releasableAt).toLocaleTimeString()}.`,
    );
  }

  // --- Accounts ---
  async listAccounts(): Promise<AccountInfo[]> {
    const accounts = await loadAccounts(this.store);
    if (!this.network) return accounts;
    const isMainnet = this.network === 'bitcoin';
    return accounts.map((a) => ({ ...a, derivationPath: accountKeyPath(isMainnet, a.index) }));
  }

  async getActiveAccount(): Promise<ActiveAccount> {
    return loadActiveAccount(this.store);
  }

  async renameAccount(seedId: number, accountIndex: number, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) throw new Error('Label must not be empty');
    const accounts = await loadAccounts(this.store);
    if (!accounts.some((a) => a.seedId === seedId && a.index === accountIndex)) throw new Error('No such account');
    await saveAccounts(
      this.store,
      accounts.map((a) => (a.seedId === seedId && a.index === accountIndex ? { ...a, label: trimmed } : a)),
    );
  }

  // Hides the account only: its seed and local data stay, and it remains
  // recoverable from the seed phrase.
  async removeAccount(seedId: number, accountIndex: number): Promise<void> {
    const accounts = await loadAccounts(this.store);
    if (!accounts.some((a) => a.seedId === seedId && a.index === accountIndex)) throw new Error('No such account');
    if (accounts.length === 1) throw new Error('Cannot remove the only account');
    const active = await loadActiveAccount(this.store);
    if (active.seedId === seedId && active.index === accountIndex) {
      throw new Error('Cannot remove the active account - switch to a different one first');
    }
    await saveAccounts(
      this.store,
      accounts.filter((a) => !(a.seedId === seedId && a.index === accountIndex)),
    );
  }

  private requirePassword(): string {
    if (!this.password) throw new Error('Wallet is locked');
    return this.password;
  }

  // Adds the next account index under the active seed.
  async addAccount(label?: string): Promise<AccountInfo> {
    const password = this.requirePassword();
    const seedId = this.seedId ?? 0;
    const mnemonic = await this._decryptSeedOrThrow(seedId, password);
    const accounts = await loadAccounts(this.store);
    // Accounts stored before multi-seed support have no seedId.
    const sameSeedIndices = accounts
      .filter((a) => (Number.isFinite(a.seedId) ? a.seedId : 0) === seedId)
      .map((a) => a.index);
    const nextIndex = sameSeedIndices.length === 0 ? 0 : Math.max(...sameSeedIndices) + 1;
    const info: AccountInfo = { seedId, index: nextIndex, label: label?.trim() || `Account ${accounts.length + 1}` };
    await saveAccounts(this.store, [...accounts, info]);
    await saveActiveAccount(this.store, { seedId, index: nextIndex });
    try {
      await this._initWallet(mnemonic, password, seedId, nextIndex);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
    return info;
  }

  // Imports an independent seed as a new account, under the same password.
  async importSeed(rawMnemonic: string, label?: string): Promise<AccountInfo> {
    const password = this.requirePassword();
    const mnemonic = normalizeMnemonic(rawMnemonic);
    assertValidMnemonic(mnemonic);
    const accounts = await loadAccounts(this.store);
    const nextSeedId = await this.nextFreeSeedId(accounts);
    const encrypted = await encryptMnemonic(mnemonic, password);
    await saveEncryptedMnemonic(this.store, encrypted, nextSeedId);
    const info: AccountInfo = { seedId: nextSeedId, index: 0, label: label?.trim() || `Account ${accounts.length + 1}` };
    await saveAccounts(this.store, [...accounts, info]);
    await saveActiveAccount(this.store, { seedId: nextSeedId, index: 0 });
    try {
      await this._initWallet(mnemonic, password, nextSeedId, 0);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
    return info;
  }

  // A removed account only hides its seed, which stays stored, so ids are
  // checked against storage and not just the visible list.
  private async nextFreeSeedId(accounts: AccountInfo[]): Promise<number> {
    // Accounts stored before multi-seed support have no seedId (Math.max would be NaN).
    let seedId = Math.max(0, ...accounts.map((a) => (Number.isFinite(a.seedId) ? a.seedId : 0))) + 1;
    while (await hasStoredWallet(this.store, seedId)) seedId++;
    return seedId;
  }

  async switchAccount(seedId: number, accountIndex: number): Promise<void> {
    const password = this.requirePassword();
    const accounts = await loadAccounts(this.store);
    if (!accounts.some((a) => a.seedId === seedId && a.index === accountIndex)) throw new Error('No such account');
    const mnemonic = await this._decryptSeedOrThrow(seedId, password);
    await saveActiveAccount(this.store, { seedId, index: accountIndex });
    try {
      await this._initWallet(mnemonic, password, seedId, accountIndex);
    } catch (e: unknown) {
      throw new Error(`SERVER_UNREACHABLE: ${String(e)}`);
    }
  }
}
