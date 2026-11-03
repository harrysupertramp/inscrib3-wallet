import { loadNetworkSettings, saveNetworkSettings, describeNetwork, fetchConnectionInfo, type WalletManager, type NetworkSettings, type KeyValueStore, type VtxoOutpoint } from '@inscrib3/core';
import { isInternalMethod, isInternalSender, isRpcMethod, type AnyRequest, type InternalResponse } from './protocol.js';
import { connect, isConnected, getConnectedOrigins, revoke } from '../permissions/origin-permissions.js';
import { nextApprovalId, requestApproval, resolveApproval, type ApprovalRequest } from '../approval/approval-manager.js';
import { savePendingRequest, loadPendingRequest, clearPendingRequest } from '../approval/approval-persistence.js';
import { broadcastEvent, notifyUi } from './broadcast.js';
import { encodeBigints, decodeBigints } from './bigint-wire.js';
import { AUTO_LOCK_ALARM_NAME, scheduleAutoLock, cancelAutoLock } from '../wallet/auto-lock.js';
import { VERSION_CHECK_ALARM_NAME, checkForNewVersion, getVersionInfo, dismissVersionUpdate } from '../wallet/version-check.js';

function ok(id: string, result: unknown): InternalResponse {
  return { id, result };
}

function err(id: string, message: string): InternalResponse {
  return { id, error: message };
}

// Approval windows show the whole message: signing a truncated view would
// be blind-signing.
const MAX_SIGNABLE_MESSAGE_LENGTH = 1024;

const WALLET_LOCKED_FOR_APPROVAL = 'Wallet is locked. Open the extension, unlock it, then try again.';

const WALLET_CHANGED_DURING_APPROVAL =
  'The active account or network changed while this request was open, so nothing was done. Ask the site to try again.';

const OPEN_RPC_METHODS: ReadonlySet<string> = new Set([
  'arkade_connect',
  'arkade_disconnect',
  'arkade_getAccounts',
  'arkade_isConnected',
  'arkade_getProviderState',
]);

export class BackgroundRouter {
  constructor(private readonly manager: WalletManager, private readonly store: KeyValueStore) {
    this.manager.onIncomingFunds((funds) => {
      void notifyUi('fundsReceived', funds);
    });
  }

  init(): void {
    browser.runtime.onMessage.addListener(
      (message: unknown, sender, sendResponse): true | undefined => {
        const msg = message as AnyRequest;
        if (!msg || typeof msg !== 'object' || !('id' in msg) || !('method' in msg)) {
          return undefined;
        }
        // Only our own windows use the bigint encoding; dApp traffic is plain JSON.
        const internal = isInternalSender(sender);
        const request = internal ? { ...msg, params: decodeBigints(msg.params) } : msg;
        this._handle(request as AnyRequest, sender)
          .then((response) => sendResponse(internal ? encodeBigints(response) : response))
          .catch((e: unknown) => sendResponse(err(msg.id, String(e))));
        return true; // keep channel open for async response
      },
    );

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUTO_LOCK_ALARM_NAME) {
        void this.manager.lock().then(() => broadcastEvent('lock'));
      } else if (alarm.name === VERSION_CHECK_ALARM_NAME) {
        void checkForNewVersion(this.store);
      }
    });
  }

  // Persisted so a service-worker restart mid-approval doesn't drop the answer.
  private async _requestApprovalPersisted(
    approvalId: string,
    req: ApprovalRequest,
    method: string,
    params: unknown,
    walletKey: string,
  ): Promise<boolean> {
    await savePendingRequest(approvalId, { method, params, origin: req.origin, walletKey });
    try {
      return await requestApproval(approvalId, { ...req, ...(await this._activeWalletLabels()) });
    } finally {
      await clearPendingRequest(approvalId);
    }
  }

  private async _approveThenPerform(
    id: string,
    req: ApprovalRequest,
    method: string,
    params: unknown,
    rejectedMessage: string,
  ): Promise<InternalResponse> {
    // The popup has no unlock step, so an approval opened now could only fail.
    if (!this.manager.isUnlocked()) return err(id, WALLET_LOCKED_FOR_APPROVAL);
    const walletKey = await this._activeWalletKey();
    const approved = await this._requestApprovalPersisted(nextApprovalId(), req, method, params, walletKey);
    if (!approved) return err(id, rejectedMessage);
    if (walletKey !== (await this._activeWalletKey())) return err(id, WALLET_CHANGED_DURING_APPROVAL);
    return ok(id, await this._performApprovedAction(method, params, req.origin));
  }

  // The popup names this wallet, so an approval only acts if it is still the
  // active one: switching account or network meanwhile must not redirect it.
  private async _activeWalletKey(): Promise<string> {
    const { arkServerUrl } = await loadNetworkSettings(this.store);
    const active = await this.manager.getActiveAccount();
    return `${arkServerUrl}|${active.seedId}:${active.index}`;
  }

  private async _activeWalletLabels(): Promise<{ network: string; account: string }> {
    const network = describeNetwork(await loadNetworkSettings(this.store)).displayName;
    const active = await this.manager.getActiveAccount();
    const accounts = await this.manager.listAccounts();
    const match = accounts.find((a) => a.seedId === active.seedId && a.index === active.index);
    return { network, account: match?.label ?? 'Account 1' };
  }

  // Shared by the live path and approval_respond's restart recovery.
  private async _performApprovedAction(method: string, params: unknown, origin: string): Promise<unknown> {
    switch (method) {
      case 'arkade_connect': {
        // Address first: a connection is only saved once it can be answered.
        const address = await this.manager.getAddress();
        await connect(origin);
        await broadcastEvent('accountsChanged', [address], origin);
        return [address];
      }
      case 'arkade_sendToAddress': {
        const { address, amount } = params as { address: string; amount: number };
        return this.manager.send(address, amount);
      }
      case 'arkade_sendAsset': {
        const { address, assets, bitcoinAmount } = params as {
          address: string;
          assets: Array<{ assetId: string; amount: number }>;
          bitcoinAmount?: number;
        };
        return this.manager.sendAsset(address, assets, bitcoinAmount);
      }
      case 'arkade_settle':
        return this.manager.settle();
      case 'arkade_signMessage': {
        const { message } = params as { message: string };
        return this.manager.signMessage(message);
      }
      default:
        throw new Error(`Cannot recover approval for unknown method: ${method}`);
    }
  }

  // Pages only get the new address scoped to their own origin; an origin-less
  // event would be relayed into every tab, connected or not.
  private async _broadcastAccountSwitch(): Promise<void> {
    await broadcastEvent('accountChanged');
    if (!this.manager.isUnlocked()) return;
    const address = await this.manager.getAddress();
    for (const origin of await getConnectedOrigins()) {
      await broadcastEvent('accountsChanged', [address], origin);
    }
  }

  private async _handle(msg: AnyRequest, sender: Browser.runtime.MessageSender): Promise<InternalResponse> {
    const { id, method, params } = msg;

    // Internal methods only from our own windows; dApp methods only via content.ts.
    const internal = isInternalSender(sender);
    if (isInternalMethod(method) && !internal) {
      return err(id, 'This method is not available to web pages');
    }
    if (isRpcMethod(method) && internal) {
      return err(id, 'This method is only available to web pages');
    }

    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');

    const connected = !internal && (await isConnected(origin));
    // Every dApp method except the connection handshake needs a prior
    // connect(); new methods are gated by default.
    if (isRpcMethod(method) && !OPEN_RPC_METHODS.has(method) && !connected) {
      return err(id, 'Not connected. Call connect() first.');
    }

    // Only activity in the wallet's own windows extends auto-lock (approving a
    // dApp request included): a connected page that polls can't keep it open.
    if (method !== 'wallet_lock' && this.manager.isUnlocked() && internal) {
      scheduleAutoLock();
    }

    // Broadcasts are awaited: an MV3 worker can be torn down once it looks idle.
    switch (method) {
      // --- Wallet lifecycle ---
      case 'wallet_generateMnemonic':
        return ok(id, this.manager.generateMnemonic());

      case 'wallet_isCreated':
        return ok(id, await this.manager.isCreated());

      case 'wallet_isUnlocked':
        return ok(id, this.manager.isUnlocked());

      case 'wallet_create': {
        const { mnemonic, password } = params as { mnemonic: string; password: string };
        await this.manager.create(mnemonic, password);
        scheduleAutoLock();
        await broadcastEvent('unlock');
        return ok(id, true);
      }

      case 'wallet_restore': {
        const { mnemonic, password } = params as { mnemonic: string; password: string };
        await this.manager.restore(mnemonic, password);
        scheduleAutoLock();
        await broadcastEvent('unlock');
        return ok(id, true);
      }

      case 'wallet_unlock': {
        const { password } = params as { password: string };
        await this.manager.unlock(password);
        scheduleAutoLock();
        await broadcastEvent('unlock');
        return ok(id, true);
      }

      case 'wallet_lock':
        await this.manager.lock();
        cancelAutoLock();
        await broadcastEvent('lock');
        return ok(id, true);

      // --- Wallet reads ---
      case 'wallet_getAddress':
        return ok(id, await this.manager.getAddress());

      case 'wallet_getBoardingAddress':
        return ok(id, await this.manager.getBoardingAddress());

      case 'wallet_getExitFeeAddress':
        return ok(id, await this.manager.getExitFeeAddress());

      case 'wallet_getBalance':
        return ok(id, await this.manager.getBalance());

      case 'wallet_getVtxos':
        return ok(id, await this.manager.getVtxos());

      case 'wallet_getTransactionHistory':
        return ok(id, await this.manager.getTransactionHistory());

      case 'wallet_getAssetTransactionHistory': {
        const { assetId } = params as { assetId: string };
        return ok(id, await this.manager.getAssetTransactionHistory(assetId));
      }

      case 'wallet_getAssets':
        return ok(id, await this.manager.getAssets());

      case 'wallet_getAssetMetadata': {
        const { assetId } = params as { assetId: string };
        return ok(id, await this.manager.getAssetMetadata(assetId));
      }

      // --- Lightning ---
      case 'wallet_isLightningAvailable':
        return ok(id, this.manager.isLightningAvailable());

      case 'wallet_createLightningInvoice': {
        const { amount } = params as { amount: number };
        return ok(id, await this.manager.createLightningInvoice(amount));
      }

      case 'wallet_getLightningInvoiceStatus': {
        const { swapId } = params as { swapId: string };
        return ok(id, await this.manager.getLightningInvoiceStatus(swapId));
      }

      case 'wallet_prepareLightningPayment': {
        const { invoice } = params as { invoice: string };
        return ok(id, await this.manager.prepareLightningPayment(invoice));
      }

      case 'wallet_confirmLightningPayment': {
        const { quoteId } = params as { quoteId: string };
        return ok(id, await this.manager.confirmLightningPayment(quoteId));
      }

      // --- Unilateral exit ---
      case 'wallet_estimateExit': {
        const { sweepAddress } = params as { sweepAddress: string };
        return ok(id, await this.manager.estimateExit(sweepAddress));
      }

      case 'wallet_startExit': {
        const { sweepAddress } = params as { sweepAddress: string };
        await this.manager.startExit(sweepAddress);
        return ok(id, true);
      }

      case 'wallet_hasPendingExit':
        return ok(id, await this.manager.hasPendingExit());

      case 'wallet_getExitProgress':
        return ok(id, await this.manager.getExitProgress());

      // --- Coin control ---
      case 'wallet_getSpendableVtxos':
        return ok(id, await this.manager.getSpendableVtxos());

      // --- Transactions ---
      case 'wallet_send': {
        const { address, amount, selectedVtxos } = params as {
          address: string;
          amount: number;
          selectedVtxos?: VtxoOutpoint[];
        };
        const txid = await this.manager.send(address, amount, selectedVtxos);
        return ok(id, txid);
      }

      case 'wallet_quoteOnchainSend': {
        const { address, amount } = params as { address: string; amount: number };
        return ok(id, await this.manager.quoteOnchainSend(address, amount));
      }

      case 'wallet_sendOnchain': {
        const { address, amount } = params as { address: string; amount?: number };
        const txid = await this.manager.sendOnchain(address, amount);
        return ok(id, txid);
      }

      case 'wallet_sendAsset': {
        const { address, assets, bitcoinAmount, selectedVtxos } = params as {
          address: string;
          assets: Array<{ assetId: string; amount: number }>;
          bitcoinAmount?: number;
          selectedVtxos?: VtxoOutpoint[];
        };
        const txid = await this.manager.sendAsset(address, assets, bitcoinAmount, selectedVtxos);
        return ok(id, txid);
      }

      case 'wallet_settle': {
        const txid = await this.manager.settle();
        return ok(id, txid);
      }

      case 'wallet_isSettling':
        return ok(id, this.manager.isSettling());

      case 'wallet_getSettleProgress':
        return ok(id, await this.manager.getSettleProgress());

      case 'wallet_resetLocalCache': {
        const { password } = params as { password: string };
        await this.manager.resetLocalCache(password);
        return ok(id, true);
      }

      // --- Extension updates ---
      case 'wallet_getVersionInfo':
        return ok(id, await getVersionInfo(this.store));

      case 'wallet_dismissVersionUpdate': {
        const { version } = params as { version: string };
        await dismissVersionUpdate(this.store, version);
        return ok(id, true);
      }

      // --- Permissions ---
      case 'wallet_getConnectedOrigins':
        return ok(id, await getConnectedOrigins());

      case 'wallet_revokeOrigin': {
        const { origin: revokedOrigin } = params as { origin: string };
        await revoke(revokedOrigin);
        await broadcastEvent('accountsChanged', [], revokedOrigin);
        return ok(id, true);
      }

      case 'wallet_signMessage': {
        const { message } = params as { message: string };
        return ok(id, await this.manager.signMessage(message));
      }

      case 'wallet_exportMnemonic': {
        const { password } = params as { password: string };
        return ok(id, await this.manager.exportMnemonic(password));
      }

      case 'wallet_getNetworkSettings':
        return ok(id, await loadNetworkSettings(this.store));

      // Works while locked.
      case 'wallet_getConnectionInfo':
        return ok(id, await fetchConnectionInfo(await loadNetworkSettings(this.store)));

      case 'wallet_setNetworkSettings': {
        const settings = params as NetworkSettings;
        await saveNetworkSettings(this.store, settings);
        const network = describeNetwork(settings).network;
        if (!this.manager.isUnlocked()) {
          await broadcastEvent('networkChanged', network);
          return ok(id, true);
        }
        // Reconnects with the cached password instead of forcing a re-unlock.
        // Events go out afterwards so the UI never reloads mid-reconnect.
        try {
          await this.manager.reconnect();
        } catch (e: unknown) {
          cancelAutoLock();
          await broadcastEvent('lock');
          await broadcastEvent('networkChanged', network);
          return err(id, `Saved, but the new server couldn't be reached - unlock to try again. ${String(e)}`);
        }
        await broadcastEvent('networkChanged', network);
        // The address differs per network, so connected dApps need the new one.
        await this._broadcastAccountSwitch();
        return ok(id, true);
      }

      // --- Accounts ---
      case 'wallet_listAccounts':
        return ok(id, await this.manager.listAccounts());

      case 'wallet_getActiveAccount':
        return ok(id, await this.manager.getActiveAccount());

      case 'wallet_addAccount': {
        const { label } = (params as { label?: string } | undefined) ?? {};
        const info = await this.manager.addAccount(label);
        await this._broadcastAccountSwitch();
        return ok(id, info);
      }

      case 'wallet_importSeed': {
        const { mnemonic, label } = params as { mnemonic: string; label?: string };
        const info = await this.manager.importSeed(mnemonic, label);
        await this._broadcastAccountSwitch();
        return ok(id, info);
      }

      case 'wallet_switchAccount': {
        const { seedId, accountIndex } = params as { seedId: number; accountIndex: number };
        await this.manager.switchAccount(seedId, accountIndex);
        await this._broadcastAccountSwitch();
        return ok(id, true);
      }

      case 'wallet_renameAccount': {
        const { seedId, accountIndex, label } = params as { seedId: number; accountIndex: number; label: string };
        await this.manager.renameAccount(seedId, accountIndex, label);
        return ok(id, true);
      }

      case 'wallet_removeAccount': {
        const { seedId, accountIndex } = params as { seedId: number; accountIndex: number };
        await this.manager.removeAccount(seedId, accountIndex);
        return ok(id, true);
      }

      case 'wallet_resetToPrimaryAccount':
        await this.manager.resetToPrimaryAccount();
        return ok(id, true);

      // --- Approval window responses ---
      case 'approval_respond': {
        const { approvalId, approved } = params as { approvalId: string; approved: boolean };
        const resolved = resolveApproval(approvalId, approved);
        if (resolved) return ok(id, true);

        // The service worker restarted while pending: recover from storage.
        const pending = await loadPendingRequest(approvalId);
        if (!pending) {
          return err(id, 'This request has expired (the extension restarted while it was pending) - please try again from the site.');
        }
        await clearPendingRequest(approvalId);
        if (!approved) return ok(id, true);
        if (pending.walletKey !== (await this._activeWalletKey())) return err(id, WALLET_CHANGED_DURING_APPROVAL);
        return ok(id, await this._performApprovedAction(pending.method, pending.params, pending.origin));
      }

      // --- dApp RPC (relayed by content.ts) ---
      case 'arkade_connect':
        if (connected) return ok(id, [await this.manager.getAddress()]);
        return this._approveThenPerform(id, { type: 'connect', origin }, method, params, 'User rejected the connection request');

      case 'arkade_disconnect': {
        await revoke(origin);
        await broadcastEvent('accountsChanged', [], origin);
        return ok(id, true);
      }

      case 'arkade_getAccounts': {
        if (!connected || !this.manager.isUnlocked()) return ok(id, []);
        return ok(id, [await this.manager.getAddress()]);
      }

      case 'arkade_isConnected':
        return ok(id, connected);

      case 'arkade_getProviderState': {
        if (!connected) {
          return ok(id, { isConnected: false, isUnlocked: false, network: null, accounts: [] });
        }
        const unlocked = this.manager.isUnlocked();
        const netInfo = describeNetwork(await loadNetworkSettings(this.store));
        const accounts = unlocked ? [await this.manager.getAddress()] : [];
        return ok(id, { isConnected: true, isUnlocked: unlocked, network: netInfo.network, accounts });
      }

      case 'arkade_getAddress': {
        return ok(id, await this.manager.getAddress());
      }

      case 'arkade_getXOnlyPublicKey': {
        return ok(id, await this.manager.getXOnlyPublicKey());
      }

      case 'arkade_getBoardingAddress': {
        return ok(id, await this.manager.getBoardingAddress());
      }

      case 'arkade_getBalance': {
        const balance = await this.manager.getBalance();
        return ok(id, {
          available: balance.available,
          total: balance.total,
          vtxo: {
            confirmed: balance.settled,
            unconfirmed: balance.preconfirmed,
            total: balance.settled + balance.preconfirmed,
          },
          boarding: balance.boarding,
        });
      }

      case 'arkade_getNetwork': {
        return ok(id, describeNetwork(await loadNetworkSettings(this.store)));
      }

      case 'arkade_getAssets': {
        return ok(id, await this.manager.getAssets());
      }

      case 'arkade_getTransactionHistory': {
        return ok(id, await this.manager.getTransactionHistory());
      }

      // A signature proves control of the wallet to a third party, so it is
      // approval-gated like a send.
      case 'arkade_signMessage': {
        const { message } = params as { message: unknown };
        if (typeof message !== 'string' || message.length === 0) {
          return err(id, 'message must be a non-empty string');
        }
        if (message.length > MAX_SIGNABLE_MESSAGE_LENGTH) {
          return err(id, `message must be at most ${MAX_SIGNABLE_MESSAGE_LENGTH} characters`);
        }
        return this._approveThenPerform(id, { type: 'signMessage', origin, message }, method, params, 'User rejected the signature request');
      }

      // --- Transactions ---
      case 'arkade_sendToAddress': {
        const { address, amount } = params as { address: string; amount: number };
        return this._approveThenPerform(id, { type: 'sendToAddress', origin, address, amount }, method, params, 'User rejected the transaction');
      }

      case 'arkade_sendAsset': {
        const { address, assets, bitcoinAmount } = params as {
          address: string;
          assets: Array<{ assetId: string; amount: number }>;
          bitcoinAmount?: number;
        };
        return this._approveThenPerform(
          id,
          { type: 'sendAsset', origin, address, amount: bitcoinAmount, assets },
          method,
          params,
          'User rejected the transaction',
        );
      }

      case 'arkade_settle':
        return this._approveThenPerform(id, { type: 'settle', origin }, method, params, 'User rejected the settlement');

      default:
        return err(id, `Unknown method: ${method}`);
    }
  }
}
