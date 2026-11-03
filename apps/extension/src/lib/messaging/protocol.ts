// Methods a dApp may call. The type derives from the array so the runtime
// gate can't drift from it.
export const RPC_METHODS = [
  'arkade_connect',
  'arkade_disconnect',
  'arkade_getAccounts',
  'arkade_isConnected',
  'arkade_getProviderState',
  'arkade_getAddress',
  'arkade_getBoardingAddress',
  'arkade_getXOnlyPublicKey',
  'arkade_getBalance',
  'arkade_getNetwork',
  'arkade_getAssets',
  'arkade_getTransactionHistory',
  'arkade_sendToAddress',
  'arkade_sendAsset',
  'arkade_settle',
  'arkade_signMessage',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];
const RPC_METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params?: unknown;
  origin?: string;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// Methods only our own windows may call - a runtime security boundary.
export const INTERNAL_METHODS = [
  'wallet_generateMnemonic',
  'wallet_create',
  'wallet_restore',
  'wallet_unlock',
  'wallet_lock',
  'wallet_isCreated',
  'wallet_isUnlocked',
  'wallet_getAddress',
  'wallet_getBoardingAddress',
  'wallet_getExitFeeAddress',
  'wallet_getBalance',
  'wallet_getVtxos',
  'wallet_send',
  'wallet_quoteOnchainSend',
  'wallet_sendOnchain',
  'wallet_settle',
  'wallet_getAssets',
  'wallet_getAssetMetadata',
  'wallet_sendAsset',
  'wallet_getConnectedOrigins',
  'wallet_revokeOrigin',
  'wallet_exportMnemonic',
  'wallet_getNetworkSettings',
  'wallet_getConnectionInfo',
  'wallet_signMessage',
  'wallet_setNetworkSettings',
  'wallet_listAccounts',
  'wallet_getActiveAccount',
  'wallet_addAccount',
  'wallet_importSeed',
  'wallet_switchAccount',
  'wallet_renameAccount',
  'wallet_removeAccount',
  'wallet_resetToPrimaryAccount',
  'wallet_getTransactionHistory',
  'wallet_getAssetTransactionHistory',
  'wallet_isLightningAvailable',
  'wallet_createLightningInvoice',
  'wallet_getLightningInvoiceStatus',
  'wallet_prepareLightningPayment',
  'wallet_confirmLightningPayment',
  'wallet_estimateExit',
  'wallet_startExit',
  'wallet_hasPendingExit',
  'wallet_getExitProgress',
  'wallet_getSpendableVtxos',
  'wallet_isSettling',
  'wallet_getSettleProgress',
  'wallet_resetLocalCache',
  'wallet_getVersionInfo',
  'wallet_dismissVersionUpdate',
  'approval_respond',
] as const;
export type InternalMethod = (typeof INTERNAL_METHODS)[number];
const INTERNAL_METHOD_SET: ReadonlySet<string> = new Set(INTERNAL_METHODS);

export function isInternalMethod(method: string): method is InternalMethod {
  return INTERNAL_METHOD_SET.has(method);
}

export function isRpcMethod(method: string): method is RpcMethod {
  return RPC_METHOD_SET.has(method);
}

export interface InternalRequest {
  id: string;
  method: InternalMethod;
  params?: unknown;
}

export interface InternalResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export type AnyMethod = InternalMethod | RpcMethod;

export interface AnyRequest {
  id: string;
  method: AnyMethod;
  params?: unknown;
}

// page -> content script
export interface PageMessage {
  _arkade: true;
  request: RpcRequest;
}

// content script -> page
export interface PageResponse {
  _arkade: true;
  response: RpcResponse;
}

// The page builds this object, so only a well-formed request goes on.
// Anything else it carried (an event marker, say) would otherwise reach every
// extension window, the popup included.
export function toRpcRequest(request: unknown): { id: string; method: string; params?: unknown } | null {
  if (typeof request !== 'object' || request === null) return null;
  const { id, method, params } = request as Record<string, unknown>;
  if (typeof id !== 'string' || typeof method !== 'string') return null;
  return { id, method, params };
}

// Our own windows and service worker share one channel with pages relayed by
// content.ts; only the sender origin tells them apart. The origin is
// string-stripped rather than new URL().origin, which is "null" for
// chrome-extension:// outside Chrome, and computed per call so this module
// stays safe to load where no browser API exists.
export function isInternalSender(sender: Browser.runtime.MessageSender): boolean {
  const extensionOrigin = browser.runtime.getURL('/').replace(/\/$/, '');
  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return senderOrigin === extensionOrigin;
}

export function isPageMessage(data: unknown): data is PageMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    '_arkade' in data &&
    (data as PageMessage)._arkade === true &&
    'request' in data
  );
}

// Events a page may see. 'accountsChanged' carries string[] (empty on
// disconnect); 'accountChanged' has no payload and only tells the UI to refetch.
export const ARKADE_EVENTS = [
  'accountsChanged',
  'accountChanged',
  'networkChanged',
  'lock',
  'unlock',
] as const;
export type ArkadeEventName = (typeof ARKADE_EVENTS)[number];
const ARKADE_EVENT_SET: ReadonlySet<string> = new Set(ARKADE_EVENTS);

export function isArkadeEventName(name: string): name is ArkadeEventName {
  return ARKADE_EVENT_SET.has(name);
}

// Popup-only events: `fundsReceived` carries amounts, so it never goes to tabs.
export type UiOnlyEventName = 'fundsReceived';
export type PageEventName = ArkadeEventName | UiOnlyEventName;

export interface PageEvent {
  _arkadeEvent: true;
  event: PageEventName;
  data?: unknown;
  // Set for events scoped to one dApp; content.ts only relays them to that origin.
  origin?: string;
}

export function isPageEvent(data: unknown): data is PageEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    '_arkadeEvent' in data &&
    (data as PageEvent)._arkadeEvent === true
  );
}
