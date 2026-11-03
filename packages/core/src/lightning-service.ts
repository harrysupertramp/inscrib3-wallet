import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { contractSigner, type IWallet, type RestArkProvider, type RestIndexerProvider } from '@arkade-os/sdk';
import {
  RfqSwapManager,
  arkadeRefunder,
  preimageForSwapRecord,
  pushClaim,
  readLockupFate,
  requestLightningReceive,
  requestLightningSend,
  rfqClaimSecretOf,
  rfqSecretsProfile,
  type LightningReceiveSwap,
  type LightningSendSwap,
  type LockupVtxo,
  type ReceiveLockupSwap,
  type RfqSwap,
  type RfqSwapOrigin,
} from '@arkade-os/swap/protocol';
import { nostrRfqTransport } from '@arkade-os/swap/nostr';
import { Client as SatoraClient, type SwapActions } from '@satora/swap';
import type { KeyValueStore } from './key-value-store.js';
import { decodeInvoice } from './bolt11.js';
import { PasswordCipher } from './session.js';
import { KeyValueRfqSwapStore } from './rfq-swap-store.js';
import { SatoraSignerStorage } from './satora-signer-storage.js';
import { KeyValueSatoraSwapStorage } from './satora-swap-storage.js';
import type { NetworkInfo } from './network-settings.js';
import { assertValidAmount, assertValidAddress } from './validation.js';
import { verifySatoraSendQuote, assertLightningFee } from './satora-verify.js';

// Txids that came from a Lightning swap: a completed swap settles as an
// ordinary Ark tx, so history needs this set to label it 'lightning'.
function txidsStorageKey(network: string, scope: string): string {
  const base = `arkade:lightning:txids:${network}`;
  return scope ? `${base}:${scope}` : base;
}

// The only known solver for Arkade's RFQ Lightning corridor. There is no
// discovery mechanism, and docs.arkadeos.com labels it developer-preview.
const DEV_PREVIEW_SOLVER = {
  relays: ['wss://nostr.arkade.sh'],
  solverPubkey: '66422c952f8dcb96e4d0c3f049cd1e265b8461b916d9913c65c2494b64b4e3ce',
};

type ArkProvider = Pick<RestArkProvider, 'getInfo' | 'submitTx' | 'finalizeTx'>;
type IndexerProvider = Pick<RestIndexerProvider, 'getVtxos' | 'getVirtualTxs'>;

// Terminal Satora statuses; anything else is still in progress.
const SATORA_SETTLED_STATUSES = new Set(['clientredeemed', 'serverredeemed']);
const SATORA_FAILED_STATUSES = new Set([
  'clientrefunded',
  'expired',
  'clientinvalidfunded',
  'clientfundedtoolate',
  'serverwontfund',
  'clientfundedserverrefunded',
  'clientrefundedserverfunded',
  'clientrefundedserverrefunded',
  'clientredeemedandclientrefunded',
]);

// After funding, a payment that didn't settle must never read as paid.
function lightningPaymentFailed(status: string): Error {
  return new Error(`LIGHTNING_PAYMENT_FAILED: the invoice was not paid (swap ${status}). The funds go back to your wallet through the swap's refund.`);
}

function lightningPaymentPending(status: string): Error {
  return new Error(`LIGHTNING_PAYMENT_PENDING: not settled after 5 minutes (swap ${status}). It may still go through - check Activity before paying this invoice again.`);
}

type SwapProvider = 'satora' | 'arkade';

// How long a prepared payment may wait for the user's confirmation.
const QUOTE_TTL_MS = 2 * 60_000;

export interface LightningPaymentQuote {
  quoteId: string;
  invoiceAmountSats: number;
  feeSats: number;
  totalSats: number;
}

type ArkadeSendRequest = Awaited<ReturnType<typeof requestLightningSend>> & { paymentHash: string };
type PreparedPayment =
  | { provider: 'arkade'; quoteId: string; amount: number; request: ArkadeSendRequest }
  | { provider: 'satora'; quoteId: string; amount: number; response: { id: string; arkade_vhtlc_address: string } };

// arkade_claim_txid only exists on the Arkade members of Satora's swap union.
function satoraClaimTxid(swap: object): string | undefined {
  const claimTxid = (swap as { arkade_claim_txid?: string | null }).arkade_claim_txid;
  return claimTxid ?? undefined;
}

// Two Lightning<->Ark swap providers: Arkade RFQ first, Satora as fallback.
// Fallback only happens before any funds move - once a provider is funded,
// the swap is committed to it. Both persist in-flight swaps so claims and
// refunds resume after a restart.
export class LightningService {
  private wallet: IWallet | null = null;
  private arkProvider: ArkProvider | null = null;
  private indexerProvider: IndexerProvider | null = null;
  private swapStore: KeyValueRfqSwapStore | null = null;
  private manager: RfqSwapManager | null = null;
  private satora: SatoraClient | null = null;
  private network: string | null = null;
  private scope: string | null = null;

  // Required by sealClaimPacket, but no covclaimd deployment exists yet, so
  // this key is never used to decrypt anything.
  private readonly covclaimdPubkey = secp256k1.getPublicKey(secp256k1.keygen().secretKey, true);

  // Latest swap state from the manager's events, for getInvoiceStatus().
  private readonly latestByRfqId = new Map<string, RfqSwap>();
  // Which provider owns a swap id, so status polls are routed explicitly.
  private readonly providerById = new Map<string, SwapProvider>();
  private readonly preparedPayments = new Map<string, PreparedPayment & { preparedAt: number }>();

  constructor(private readonly store: KeyValueStore) {}

  async init(
    wallet: IWallet,
    networkInfo: NetworkInfo,
    arkProvider: ArkProvider,
    indexerProvider: IndexerProvider,
    password: string,
    scope: string,
    isMainnet: boolean,
  ): Promise<void> {
    this.network = networkInfo.network;
    this.scope = scope;
    this.wallet = wallet;
    this.arkProvider = arkProvider;
    this.indexerProvider = indexerProvider;
    // Both providers are mainnet-only (Satora's API, the RFQ solver), so on
    // any other network Lightning reports itself unavailable instead of
    // failing mid-request.
    if (!isMainnet) return;
    await Promise.all([this.initArkadeRfq(wallet, arkProvider, indexerProvider), this.initSatora(networkInfo, password)]);
  }

  private async initArkadeRfq(wallet: IWallet, arkProvider: ArkProvider, indexerProvider: IndexerProvider): Promise<void> {
    try {
      const swapStore = new KeyValueRfqSwapStore(this.store, this.network as string, this.scope ?? '');
      const contracts = await wallet.getContractManager();
      const manager = new RfqSwapManager(
        { indexer: indexerProvider, contracts, repository: swapStore },
        {
          events: {
            onSwapUpdate: (swap) => this.latestByRfqId.set(swap.rfqId, swap),
            onSwapCompleted: (swap) => this.latestByRfqId.set(swap.rfqId, swap),
            onSwapFailed: (swap) => this.latestByRfqId.set(swap.rfqId, swap),
          },
        },
      );
      manager.setCallbacks({
        claimLockup: (swap, vtxos, options) => this.claimLockup(swap, vtxos, options),
        refundArkade: arkadeRefunder({ operator: arkProvider, contracts, wallet, repository: swapStore }),
      });
      // Resumes swaps left in flight by a previous session.
      await manager.restoreFromRepository();
      await manager.start();
      this.swapStore = swapStore;
      this.manager = manager;
    } catch {
      this.swapStore = null;
      this.manager = null;
    }
  }

  private async initSatora(networkInfo: NetworkInfo, password: string): Promise<void> {
    try {
      const cipher = new PasswordCipher(password);
      const signerStorage = new SatoraSignerStorage(this.store, cipher, this.scope ?? '');
      const swapStorage = new KeyValueSatoraSwapStorage(this.store, this.network as string, cipher, this.scope ?? '');
      const client = await SatoraClient.builder()
        // Without these the SDK defaults to mainnet URLs whatever network is active.
        .withArkadeServerUrl(networkInfo.arkServerUrl)
        .withEsploraUrl(networkInfo.esploraUrl)
        .withSignerStorage(signerStorage)
        .withSwapStorage(swapStorage)
        .withAutoClaim({ onActionRequired: (swapId, actions) => this.handleSatoraActionRequired(swapId, actions) })
        .build();
      await client.startTracking();
      this.satora = client;
    } catch {
      this.satora = null;
    }
  }

  async dispose(): Promise<void> {
    this.network = null;
    this.scope = null;
    // Swap ids must not stay queryable after switching accounts.
    this.latestByRfqId.clear();
    this.providerById.clear();
    this.preparedPayments.clear();
    const manager = this.manager;
    const satora = this.satora;
    this.manager = null;
    this.satora = null;
    this.swapStore = null;
    this.wallet = null;
    this.arkProvider = null;
    this.indexerProvider = null;
    await Promise.all([
      manager
        ? // locking must never block on this
          Promise.race([manager.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined)
        : undefined,
      satora
        ? Promise.resolve()
            .then(() => satora.stopTracking())
            .catch(() => undefined)
        : undefined,
    ]);
  }

  isAvailable(): boolean {
    return this.manager !== null || this.satora !== null;
  }

  async createInvoice(amountSats: number): Promise<{ invoice: string; swapId: string; expiresAt: number }> {
    assertValidAmount(amountSats);
    if (!this.satora && !this.manager) throw new Error('Lightning is not available');

    // The payer funds a receive, so an RFQ failure here is always safe to retry on Satora.
    if (this.manager && this.wallet) {
      try {
        return await this.createInvoiceViaArkadeRfq(this.manager, this.wallet, amountSats);
      } catch {
        // fall through to Satora below
      }
    }

    if (!this.satora || !this.wallet) throw new Error('Lightning is not available');
    const targetAddress = await this.wallet.getAddress();
    const result = await this.satora.createLightningToArkadeSwap({ targetAmountSats: amountSats, targetAddress });
    this.providerById.set(result.response.id, 'satora');
    return {
      invoice: result.response.bolt11_invoice,
      swapId: result.response.id,
      expiresAt: result.response.invoice_expires_at,
    };
  }

  private async createInvoiceViaArkadeRfq(
    manager: RfqSwapManager,
    wallet: IWallet,
    amountSats: number,
  ): Promise<{ invoice: string; swapId: string; expiresAt: number }> {
    const transport = nostrRfqTransport(DEV_PREVIEW_SOLVER);
    try {
      const result = await requestLightningReceive(wallet, transport, {
        amount: amountSats,
        amountSide: 'to',
        covclaimdPubkey: this.covclaimdPubkey,
        decodeInvoice,
      });
      const now = Math.floor(Date.now() / 1000);
      const paymentHash = hex.encode(result.secrets.paymentHash);
      const origin: RfqSwapOrigin = {
        kind: 'lightning_receive',
        lockupAddress: result.address,
        profile: {
          ...rfqSecretsProfile(result.secrets, paymentHash),
          expectedAmount: result.expectedAmount,
          payoutAddress: result.payoutAddress,
        },
      };
      const swap: LightningReceiveSwap = {
        kind: 'lightning_receive',
        rfqId: result.rfqId,
        state: 'pending',
        lockupPkScript: result.swapPkScript,
        lockup: { script: result.script, address: result.address },
        paymentHash,
        refundLocktime: result.quote.refund_locktime as number,
        createdAt: now,
        updatedAt: now,
        expectedAmount: result.expectedAmount,
      };
      await manager.addSwap(swap, origin);
      this.latestByRfqId.set(swap.rfqId, swap);
      this.providerById.set(swap.rfqId, 'arkade');
      return { invoice: result.invoice, swapId: result.rfqId, expiresAt: result.invoiceExpiresAt };
    } finally {
      await transport.close();
    }
  }

  // Step 1 of a payment: get a verified quote from a provider (Arkade RFQ
  // first, Satora as fallback) without moving funds, so the user can see the
  // full cost before confirming.
  async preparePayment(invoice: string): Promise<LightningPaymentQuote> {
    assertValidAddress(invoice, 'invoice');
    if (!this.satora && !this.manager) throw new Error('Lightning is not available');
    const facts = decodeInvoice(invoice);
    this.dropExpiredQuotes();

    let quote: PreparedPayment | null = null;
    if (this.manager && this.wallet) {
      try {
        const request = await this.requestArkadeRfqSend(this.wallet, invoice);
        quote = { provider: 'arkade', quoteId: request.rfqId, amount: request.fundAmount, request };
      } catch {
        // Nothing funded yet - safe to fall through to Satora below.
      }
    }
    if (!quote) {
      if (!this.satora || !this.arkProvider) throw new Error('Lightning is not available');
      const created = await this.satora.createArkadeToLightningSwap({ lightningInvoice: invoice });
      this.providerById.set(created.response.id, 'satora');
      const { signerPubkey } = await this.arkProvider.getInfo();
      const amount = verifySatoraSendQuote(created.response, {
        invoice: facts,
        refundPubkey: created.swapParams.publicKey,
        serverPubkey: hex.decode(signerPubkey),
      });
      quote = { provider: 'satora', quoteId: created.response.id, amount, response: created.response };
    }

    this.preparedPayments.set(quote.quoteId, { ...quote, preparedAt: Date.now() });
    return {
      quoteId: quote.quoteId,
      invoiceAmountSats: facts.amountSats,
      feeSats: quote.amount - facts.amountSats,
      totalSats: quote.amount,
    };
  }

  // Step 2: funds the quote from preparePayment(). Resolves once the swap
  // settles or refunds; if the caller stops waiting, the provider still
  // drives the refund in the background.
  async confirmPayment(quoteId: string): Promise<{ amount: number; preimage: string; txid: string }> {
    const quote = this.preparedPayments.get(quoteId);
    this.preparedPayments.delete(quoteId);
    if (!quote || Date.now() - quote.preparedAt > QUOTE_TTL_MS) {
      throw new Error('LIGHTNING_QUOTE_EXPIRED: review the payment again');
    }
    if (!this.wallet) throw new Error('Lightning is not available');
    if (quote.provider === 'arkade') {
      if (!this.manager) throw new Error('Lightning is not available');
      return this.fundAndAwaitArkadeRfqSend(this.manager, this.wallet, this.indexerProvider as IndexerProvider, quote.request);
    }
    if (!this.satora) throw new Error('Lightning is not available');
    return this.fundAndAwaitSatoraSend(this.satora, this.wallet, quote.response, quote.amount);
  }

  private dropExpiredQuotes(): void {
    for (const [id, quote] of this.preparedPayments) {
      if (Date.now() - quote.preparedAt > QUOTE_TTL_MS) this.preparedPayments.delete(id);
    }
  }

  private async fundAndAwaitSatoraSend(
    satora: SatoraClient,
    wallet: IWallet,
    response: { id: string; arkade_vhtlc_address: string },
    amount: number,
  ): Promise<{ amount: number; preimage: string; txid: string }> {
    const fundingTxid = await wallet.send({ address: response.arkade_vhtlc_address, amount });
    // The funding tx is this payment's row in the wallet's history; the claim
    // is Satora's tx and never appears there.
    await this.addKnownTxid(fundingTxid);

    const deadline = Date.now() + 5 * 60_000;
    let latestStatus = 'pending';
    let claimTxid: string | undefined;
    while (Date.now() < deadline) {
      const swap = await satora.getSwap(response.id, { updateStorage: true });
      latestStatus = swap.status;
      claimTxid = satoraClaimTxid(swap);
      if (SATORA_SETTLED_STATUSES.has(swap.status) || SATORA_FAILED_STATUSES.has(swap.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    if (SATORA_FAILED_STATUSES.has(latestStatus)) throw lightningPaymentFailed(latestStatus);
    if (!SATORA_SETTLED_STATUSES.has(latestStatus)) throw lightningPaymentPending(latestStatus);
    // Satora doesn't return the preimage; the claim txid is the available proof.
    return { amount, preimage: '', txid: claimTxid ?? fundingTxid };
  }

  // Quote only - no funds move, so this may fail over to Satora.
  private async requestArkadeRfqSend(wallet: IWallet, invoice: string): Promise<ArkadeSendRequest> {
    const facts = decodeInvoice(invoice);
    const transport = nostrRfqTransport(DEV_PREVIEW_SOLVER);
    try {
      const result = await requestLightningSend(wallet, transport, { invoice: facts });
      // The SDK only checks the quote covers the invoice; it has no upper bound.
      assertLightningFee(result.fundAmount, facts.amountSats);
      return { ...result, paymentHash: facts.paymentHash };
    } finally {
      await transport.close();
    }
  }

  // From here the swap is committed to this provider.
  private async fundAndAwaitArkadeRfqSend(
    manager: RfqSwapManager,
    wallet: IWallet,
    indexerProvider: IndexerProvider,
    result: ArkadeSendRequest,
  ): Promise<{ amount: number; preimage: string; txid: string }> {
    const fundingTxid = await wallet.send({ address: result.address, amount: result.fundAmount });
    await this.addKnownTxid(fundingTxid);
    const now = Math.floor(Date.now() / 1000);
    const origin: RfqSwapOrigin = {
      kind: 'lightning_send',
      lockupAddress: result.address,
      profile: rfqSecretsProfile(result.secrets, result.paymentHash),
      fundingTxid,
    };
    const swap: LightningSendSwap = {
      kind: 'lightning_send',
      rfqId: result.rfqId,
      state: 'pending',
      lockupPkScript: result.swapPkScript,
      lockup: { script: result.script, address: result.address },
      paymentHash: result.paymentHash,
      refundLocktime: result.quote.refund_locktime as number,
      createdAt: now,
      updatedAt: now,
    };
    await manager.addSwap(swap, origin);
    this.latestByRfqId.set(swap.rfqId, swap);
    this.providerById.set(swap.rfqId, 'arkade');

    // Rejects on 'failed'; 'refunded' resolves like a success would.
    const outcome = await manager.waitForSwapCompletion(result.rfqId);
    if (outcome.txid) await this.addKnownTxid(outcome.txid);
    if (outcome.state !== 'settled') throw lightningPaymentFailed(outcome.state);
    // The preimage is read from the chain, not taken from the solver.
    const fate = await readLockupFate(indexerProvider, {
      swapPkScript: result.swapPkScript,
      paymentHash: result.paymentHash,
    });
    const preimage = fate.fate === 'claimed' ? hex.encode(fate.preimage) : '';
    return { amount: result.fundAmount, preimage, txid: outcome.txid ?? fundingTxid };
  }

  async getInvoiceStatus(swapId: string): Promise<{ status: string; completed: boolean; failed: boolean }> {
    if (!this.manager && !this.satora) throw new Error('Lightning is not available');
    const provider = this.providerById.get(swapId);

    if (provider === 'satora' && this.satora) {
      const swap = await this.satora.getSwap(swapId, { updateStorage: true });
      const completed = SATORA_SETTLED_STATUSES.has(swap.status);
      const failed = SATORA_FAILED_STATUSES.has(swap.status);
      const claimTxid = satoraClaimTxid(swap);
      if (completed && claimTxid) await this.addKnownTxid(claimTxid);
      return { status: swap.status, completed, failed };
    }

    const swap = this.latestByRfqId.get(swapId);
    if (!swap) return { status: 'unknown', completed: false, failed: false };
    const completed = swap.state === 'settled';
    const failed = swap.state === 'failed' || swap.state === 'refunded';
    if (completed && swap.kind === 'lightning_receive' && swap.claimTxid) {
      await this.addKnownTxid(swap.claimTxid);
    }
    return { status: swap.state, completed, failed };
  }

  async getKnownTxids(): Promise<Set<string>> {
    const key = txidsStorageKey(this.network ?? 'unknown', this.scope ?? '');
    const existing = (await this.store.get<string[]>(key)) ?? [];
    return new Set(existing);
  }

  private async addKnownTxid(txid: string): Promise<void> {
    if (!txid) return;
    const key = txidsStorageKey(this.network ?? 'unknown', this.scope ?? '');
    const existing = (await this.store.get<string[]>(key)) ?? [];
    if (existing.includes(txid)) return;
    await this.store.set(key, [...existing, txid]);
  }

  // Called once the solver funded a receive lockup. Everything is re-derived
  // from the persisted record so a retry after a restart behaves the same.
  private async claimLockup(
    swap: ReceiveLockupSwap,
    vtxos: readonly LockupVtxo[],
    options: { partiallyClaimed: boolean },
  ): Promise<{ txid: string; amount: number }> {
    if (!this.wallet || !this.arkProvider || !this.swapStore) throw new Error('Lightning is not available');
    if (swap.kind !== 'lightning_receive' || !swap.lockup) {
      throw new Error(`swap ${swap.rfqId} is not a claimable receive lockup`);
    }
    const record = await this.swapStore.getRfqSwap(swap.rfqId);
    if (!record) throw new Error(`no stored record for receive swap ${swap.rfqId}`);
    const claimSecret = rfqClaimSecretOf(record);
    if (!claimSecret) throw new Error(`swap ${swap.rfqId} has no claim secret`);

    const receiver = await contractSigner(this.wallet, claimSecret.signingDescriptor);
    const preimage = await preimageForSwapRecord(this.wallet, claimSecret);
    const destinationPkScript = swap.lockup.script.options.nonInteractiveParameters?.receiverPkScript;
    if (!destinationPkScript) {
      throw new Error(`swap ${swap.rfqId}'s covenant carries no payout destination`);
    }

    return pushClaim(this.arkProvider, {
      contract: swap.lockup.script,
      receiver,
      preimage,
      vtxos,
      destinationPkScript,
      expectedAmount: swap.expectedAmount,
      partiallyClaimed: options.partiallyClaimed,
    });
  }

  // Satora auto-claims on its own and surfaces refunds here; there is no second
  // human to confirm with, so refunds always run.
  private handleSatoraActionRequired(swapId: string, actions: SwapActions): void {
    if (!this.satora) return;
    const isRefund = actions.actions.some((a) => a.id === 'refund_collaborative' || a.id === 'refund_unilateral');
    if (!isRefund) return;
    this.satora.refundSwap(swapId).catch(() => {
      // the SDK re-surfaces the action on its next tick
    });
  }
}
