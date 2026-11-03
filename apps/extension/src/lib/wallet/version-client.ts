// Packaging concern, not a wallet operation, so it bypasses WalletClient.
import { sendToBackground } from '../messaging/popup-client.js';
import type { VersionInfo } from './version-check.js';

export function getVersionInfo(): Promise<VersionInfo> {
  return sendToBackground('wallet_getVersionInfo');
}

export function dismissVersionUpdate(version: string): Promise<void> {
  return sendToBackground('wallet_dismissVersionUpdate', { version });
}
