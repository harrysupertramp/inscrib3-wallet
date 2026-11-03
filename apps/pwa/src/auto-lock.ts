import type { WalletClient } from '@inscrib3/core';

// Locks after inactivity, and a while after being backgrounded (not instantly,
// so a quick tab switch doesn't lock). A PWA has no background process.
const IDLE_LOCK_MS = 5 * 60 * 1000;
const BACKGROUND_LOCK_MS = 2 * 60 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export function setupAutoLock(client: WalletClient): () => void {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityAt = Date.now();
  let hiddenAt: number | null = null;

  async function lockIfUnlocked() {
    if (await client.isUnlocked()) {
      await client.lock();
    }
  }

  function resetIdleTimer() {
    lastActivityAt = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void lockIfUnlocked();
    }, IDLE_LOCK_MS);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      hiddenAt = Date.now();
      backgroundTimer = setTimeout(() => {
        void lockIfUnlocked();
      }, BACKGROUND_LOCK_MS);
      return;
    }
    if (backgroundTimer) {
      clearTimeout(backgroundTimer);
      backgroundTimer = null;
    }
    // Mobile browsers suspend a hidden page's timers, so the time away is read
    // from the clock instead of trusted to the timers above.
    const now = Date.now();
    const awayTooLong = hiddenAt !== null && now - hiddenAt >= BACKGROUND_LOCK_MS;
    const idleTooLong = now - lastActivityAt >= IDLE_LOCK_MS;
    hiddenAt = null;
    if (awayTooLong || idleTooLong) {
      void lockIfUnlocked();
      return;
    }
    resetIdleTimer();
  }

  for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, resetIdleTimer, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  resetIdleTimer();

  return () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (backgroundTimer) clearTimeout(backgroundTimer);
    for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, resetIdleTimer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
