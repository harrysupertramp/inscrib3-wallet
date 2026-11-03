import { RestArkProvider, RestDelegateProvider } from '@arkade-os/sdk';
import type { ArkadeInfo, DelegateInfo } from '@arkade-os/sdk';
import { describeNetwork, getDelegateUrl, type NetworkSettings } from './network-settings.js';

// Every remote party the wallet talks to, for Settings > Connection. Strings
// only: ArkadeInfo's bigints can't cross extension messaging.
export interface ConnectionInfo {
  arkServerUrl: string;
  esploraUrl: string;
  // The server's answer when reachable, otherwise the URL-based guess.
  network: string;
  displayName: string;
  arkReachable: boolean;
  serverVersion: string | null;
  signerPubkey: string | null;
  unilateralExitDelay: string | null;
  boardingExitDelay: string | null;
  // null: this network has no delegator. A configured but unreachable one is
  // url set + delegateReachable false.
  delegateUrl: string | null;
  delegateReachable: boolean;
  delegatePubkey: string | null;
  delegateFeeSats: string | null;
  // Where the delegator's fee is paid.
  delegateAddress: string | null;
}

export function buildConnectionInfo(
  settings: NetworkSettings,
  arkInfo: ArkadeInfo | null,
  delegateUrl: string | null,
  delegateInfo: DelegateInfo | null,
): ConnectionInfo {
  const described = describeNetwork(settings);
  return {
    arkServerUrl: settings.arkServerUrl,
    esploraUrl: settings.esploraUrl,
    network: arkInfo?.network ?? described.network,
    displayName: described.displayName,
    arkReachable: arkInfo !== null,
    serverVersion: arkInfo?.version ?? null,
    signerPubkey: arkInfo?.signerPubkey ?? null,
    unilateralExitDelay: arkInfo ? String(arkInfo.unilateralExitDelay) : null,
    boardingExitDelay: arkInfo ? String(arkInfo.boardingExitDelay) : null,
    delegateUrl,
    delegateReachable: delegateInfo !== null,
    delegatePubkey: delegateInfo?.pubkey ?? null,
    delegateFeeSats: delegateInfo ? String(delegateInfo.fee) : null,
    delegateAddress: delegateInfo?.delegateAddress ?? null,
  };
}

// An unreachable server is the answer this screen exists to show, so failures
// and timeouts become null instead of throwing.
async function settleOrNull<T>(work: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchConnectionInfo(
  settings: NetworkSettings,
  timeoutMs = 10_000,
): Promise<ConnectionInfo> {
  const delegateUrl = getDelegateUrl(settings.arkServerUrl);
  const [arkInfo, delegateInfo] = await Promise.all([
    settleOrNull(() => new RestArkProvider(settings.arkServerUrl).getInfo(), timeoutMs),
    delegateUrl
      ? settleOrNull(() => new RestDelegateProvider(delegateUrl).getDelegateInfo(), timeoutMs)
      : Promise.resolve(null),
  ]);
  return buildConnectionInfo(settings, arkInfo, delegateUrl, delegateInfo);
}
