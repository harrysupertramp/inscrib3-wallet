// Runs in the page's JS context and exposes window.arkade.

export default defineUnlistedScript(() => {
  let _requestId = 0;
  const _pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const _listeners = new Map<string, Set<(data?: unknown) => void>>();

  function handleIncoming(data: unknown): void {
    const msg = data as
      | { _arkadeEvent?: boolean; event?: string; data?: unknown }
      | { _arkade?: boolean; response?: { id: string; result?: unknown; error?: string } }
      | null
      | undefined;

    if (msg && '_arkadeEvent' in msg && msg._arkadeEvent && typeof msg.event === 'string') {
      const callbacks = _listeners.get(msg.event);
      callbacks?.forEach((cb) => cb(msg.data));
      return;
    }

    if (!msg || !('_arkade' in msg) || !msg._arkade || !msg.response) return;
    const { id, result, error } = msg.response;
    const pending = _pending.get(id);
    if (!pending) return;
    _pending.delete(id);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  // content.ts answers the ready signal with a private MessagePort, registered
  // before page scripts run. Not a cryptographic guarantee, but it keeps
  // traffic off window.postMessage. The background never trusts the page for
  // its origin either way.
  let port: MessagePort | null = null;
  const _queuedRequests: unknown[] = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (port) return; // already handed off - ignore anything further here
    const data = event.data as { _arkadeInit?: unknown } | null;
    if (!data || data._arkadeInit !== true || !event.ports?.[0]) return;
    port = event.ports[0];
    port.onmessage = (portEvent: MessageEvent) => handleIncoming(portEvent.data);
    port.start();
    for (const msg of _queuedRequests.splice(0)) port.postMessage(msg);
  });
  window.postMessage({ _arkadeReady: true }, window.location.origin);

  function request<T>(method: string, params?: unknown): Promise<T> {
    const id = `arkade-${++_requestId}`;
    return new Promise((resolve, reject) => {
      _pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg = { _arkade: true, request: { id, method, params } };
      if (port) port.postMessage(msg);
      else _queuedRequests.push(msg);
    });
  }

  interface ProviderState {
    isConnected: boolean;
    isUnlocked: boolean;
    network: string | null;
    accounts: string[];
  }

  interface NetworkInfo {
    network: string;
    displayName: string;
    isTestnet: boolean;
    arkServerUrl: string;
  }

  interface BalanceInfo {
    available: number;
    total: number;
    vtxo: { confirmed: number; unconfirmed: number; total: number };
    boarding: { confirmed: number; unconfirmed: number; total: number };
  }

  interface AssetInfo {
    assetId: string;
    amount: number;
    displayAmount: number;
    metadata?: { name?: string; ticker?: string; decimals?: number; icon?: string };
  }

  interface TxHistoryEntry {
    txid: string;
    type: 'send' | 'receive';
    amount: number;
    status: 'confirmed' | 'pending';
    timestamp: number;
  }

  const arkade = {
    isArkade: true,

    connect(): Promise<string[]> {
      return request('arkade_connect');
    },
    disconnect(): Promise<void> {
      return request('arkade_disconnect');
    },
    getAccounts(): Promise<string[]> {
      return request('arkade_getAccounts');
    },
    isConnected(): Promise<boolean> {
      return request('arkade_isConnected');
    },
    getProviderState(): Promise<ProviderState> {
      return request('arkade_getProviderState');
    },

    getAddress(): Promise<string> {
      return request('arkade_getAddress');
    },
    getXOnlyPublicKey(): Promise<string> {
      return request('arkade_getXOnlyPublicKey');
    },
    getBoardingAddress(): Promise<string> {
      return request('arkade_getBoardingAddress');
    },
    getBalance(): Promise<BalanceInfo> {
      return request('arkade_getBalance');
    },
    getNetwork(): Promise<NetworkInfo> {
      return request('arkade_getNetwork');
    },

    getAssets(): Promise<AssetInfo[]> {
      return request('arkade_getAssets');
    },
    getTransactionHistory(): Promise<TxHistoryEntry[]> {
      return request('arkade_getTransactionHistory');
    },

    sendToAddress(address: string, amount: number): Promise<string> {
      return request('arkade_sendToAddress', { address, amount });
    },
    sendAsset(
      address: string,
      assets: Array<{ assetId: string; amount: number }>,
      bitcoinAmount?: number,
    ): Promise<string> {
      return request('arkade_sendAsset', { address, assets, bitcoinAmount });
    },
    settle(): Promise<string> {
      return request('arkade_settle');
    },
    signMessage(message: string): Promise<{ message: string; signature: string; address: string }> {
      return request('arkade_signMessage', { message });
    },

    // Events: 'accountsChanged' | 'accountChanged' | 'networkChanged' | 'lock' | 'unlock'
    on(eventName: string, callback: (data?: unknown) => void): void {
      if (!_listeners.has(eventName)) _listeners.set(eventName, new Set());
      _listeners.get(eventName)!.add(callback);
    },
    off(eventName: string, callback: (data?: unknown) => void): void {
      _listeners.get(eventName)?.delete(callback);
    },
  };

  // Freeze the object too, so another script can't swap out e.g. sendToAddress.
  Object.freeze(arkade);

  Object.defineProperty(window, 'arkade', {
    value: arkade,
    writable: false,
    configurable: false,
  });
});
