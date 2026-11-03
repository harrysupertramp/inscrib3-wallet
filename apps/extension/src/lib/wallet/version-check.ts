import type { KeyValueStore } from '@inscrib3/core';

// Chrome only auto-updates extensions with an update_url; sideloaded installs
// rely on this GitHub release check instead.
export const VERSION_CHECK_ALARM_NAME = 'arkade-version-check';
const VERSION_CHECK_INTERVAL_MINUTES = 12 * 60;

const CACHE_KEY = 'arkade:version-check';
const DISMISSED_KEY = 'arkade:version-check:dismissed';
// owner/name of the repo whose release workflow built this, so a fork or a
// moved repo checks its own releases. Local builds have none and skip it.
const RELEASES_REPO: string | undefined = import.meta.env.WXT_RELEASES_REPO;

interface VersionCheckCache {
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: number; // unix seconds
}

export interface VersionInfo {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
}

// Tags are plain X.Y.Z, so a numeric compare is enough (1.10.0 > 1.9.0).
function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.replace(/^v/, '').split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

export function scheduleVersionCheck(): void {
  browser.alarms.create(VERSION_CHECK_ALARM_NAME, { periodInMinutes: VERSION_CHECK_INTERVAL_MINUTES });
}

// main() runs on every service-worker wake, and GitHub's unauthenticated API
// allows 60 requests/hour.
export async function checkForNewVersionIfDue(store: KeyValueStore): Promise<void> {
  const cached = await store.get<VersionCheckCache>(CACHE_KEY);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.checkedAt < VERSION_CHECK_INTERVAL_MINUTES * 60) return;
  await checkForNewVersion(store);
}

export async function checkForNewVersion(store: KeyValueStore): Promise<void> {
  if (!RELEASES_REPO) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub releases check failed: ${response.status}`);
    const data = (await response.json()) as { tag_name?: string; html_url?: string };
    const cache: VersionCheckCache = {
      latestVersion: data.tag_name ?? null,
      releaseUrl: data.html_url ?? null,
      checkedAt: now,
    };
    await store.set(CACHE_KEY, cache);
  } catch {
    // Keep the previous cache on failure.
  }
}

export async function getVersionInfo(store: KeyValueStore): Promise<VersionInfo> {
  const currentVersion = browser.runtime.getManifest().version;
  const cached = await store.get<VersionCheckCache>(CACHE_KEY);
  if (!cached?.latestVersion || !isNewer(cached.latestVersion, currentVersion)) {
    return { currentVersion, updateAvailable: false, latestVersion: cached?.latestVersion ?? null, releaseUrl: cached?.releaseUrl ?? null };
  }
  const dismissed = await store.get<string>(DISMISSED_KEY);
  const updateAvailable = dismissed !== cached.latestVersion;
  return { currentVersion, updateAvailable, latestVersion: cached.latestVersion, releaseUrl: cached.releaseUrl };
}

export async function dismissVersionUpdate(store: KeyValueStore, version: string): Promise<void> {
  await store.set(DISMISSED_KEY, version);
}
