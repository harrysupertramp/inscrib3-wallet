import { describe, expect, test } from 'bun:test';
import type { ArkadeInfo, DelegateInfo } from '@arkade-os/sdk';
import { buildConnectionInfo } from './connection-info.js';
import { NETWORK_PRESETS } from './network-settings.js';

const mainnet = NETWORK_PRESETS.find((p) => p.network === 'bitcoin')!;
const settings = { arkServerUrl: mainnet.arkServerUrl, esploraUrl: mainnet.esploraUrl };

// Only the fields buildConnectionInfo reads - the real ArkadeInfo carries a few
// dozen more that this shaping logic never touches.
const arkInfo = {
  network: 'bitcoin',
  version: 'v0.9.16-rc.12',
  signerPubkey: '038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c',
  unilateralExitDelay: 605184n,
  boardingExitDelay: 7776256n,
} as unknown as ArkadeInfo;

const delegateInfo: DelegateInfo = {
  pubkey: '026d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6',
  fee: '0',
  delegateAddress: 'ark1qzpq904test',
};

describe('buildConnectionInfo', () => {
  test('reports the server’s own network and details when it answers', () => {
    const info = buildConnectionInfo(settings, arkInfo, null, null);
    expect(info.arkReachable).toBe(true);
    expect(info.network).toBe('bitcoin');
    expect(info.serverVersion).toBe('v0.9.16-rc.12');
    expect(info.signerPubkey).toBe(arkInfo.signerPubkey);
    // bigints stringified - they have to survive postMessage.
    expect(info.unilateralExitDelay).toBe('605184');
    expect(info.boardingExitDelay).toBe('7776256');
  });

  test('falls back to the URL-based guess when the server is unreachable', () => {
    const info = buildConnectionInfo(settings, null, null, null);
    expect(info.arkReachable).toBe(false);
    expect(info.network).toBe('bitcoin');
    expect(info.serverVersion).toBeNull();
    expect(info.signerPubkey).toBeNull();
    expect(info.unilateralExitDelay).toBeNull();
  });

  test('a custom server with no delegate reports no delegation service', () => {
    const custom = { arkServerUrl: 'https://my-own.example', esploraUrl: 'https://my-own.example/api' };
    const info = buildConnectionInfo(custom, null, null, null);
    expect(info.delegateUrl).toBeNull();
    expect(info.delegateReachable).toBe(false);
    expect(info.network).toBe('custom');
  });

  test('a reachable delegator reports its pubkey, fee and address', () => {
    const info = buildConnectionInfo(settings, arkInfo, 'https://delegate.arkade.money', delegateInfo);
    expect(info.delegateUrl).toBe('https://delegate.arkade.money');
    expect(info.delegateReachable).toBe(true);
    expect(info.delegatePubkey).toBe(delegateInfo.pubkey);
    expect(info.delegateFeeSats).toBe('0');
    expect(info.delegateAddress).toBe('ark1qzpq904test');
  });

  // The distinction that matters for the UI: "this network has no delegator"
  // must not look the same as "the delegator is down", because the second one
  // means VTXOs silently stop being renewed while the wallet is closed.
  test('a configured but unreachable delegator keeps its URL and reports it down', () => {
    const info = buildConnectionInfo(settings, arkInfo, 'https://delegate.arkade.money', null);
    expect(info.delegateUrl).toBe('https://delegate.arkade.money');
    expect(info.delegateReachable).toBe(false);
    expect(info.delegatePubkey).toBeNull();
  });
});
