import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { WalletClient } from '@inscrib3/core';
import { setupAutoLock } from './auto-lock.js';

// Just enough of window and document for setupAutoLock's listeners. Installed
// per test only: test files share one process, and Vue reads a global document.
let visibilityListener: (() => void) | null = null;
const fakeDocument = {
  hidden: false,
  addEventListener: (_: string, fn: () => void) => (visibilityListener = fn),
  removeEventListener: () => (visibilityListener = null),
};
const pageGlobals = globalThis as unknown as { document?: unknown; window?: unknown };

function fakeClient() {
  const state = { locks: 0 };
  const client = { isUnlocked: async () => true, lock: async () => void state.locks++ } as unknown as WalletClient;
  return { client, state };
}

function setHidden(hidden: boolean): void {
  fakeDocument.hidden = hidden;
  visibilityListener?.();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PWA auto-lock', () => {
  let teardown: () => void = () => {};
  beforeEach(() => {
    pageGlobals.document = fakeDocument;
    pageGlobals.window = { addEventListener() {}, removeEventListener() {} };
    setSystemTime(new Date('2026-10-23T12:00:00Z'));
  });
  afterEach(() => {
    teardown();
    setSystemTime();
    fakeDocument.hidden = false;
    delete pageGlobals.document;
    delete pageGlobals.window;
  });

  // Regression: on mobile the 2-minute timer never fires while hidden, and
  // coming back cleared it, so the wallet reopened unlocked hours later.
  test('locks on return when it was hidden longer than the background limit, even if no timer fired', async () => {
    const { client, state } = fakeClient();
    teardown = setupAutoLock(client);
    setHidden(true);
    setSystemTime(new Date('2026-10-23T15:00:00Z'));
    setHidden(false);
    await flush();
    expect(state.locks).toBe(1);
  });

  test('a quick tab switch does not lock', async () => {
    const { client, state } = fakeClient();
    teardown = setupAutoLock(client);
    setHidden(true);
    setSystemTime(new Date('2026-10-23T12:00:30Z'));
    setHidden(false);
    await flush();
    expect(state.locks).toBe(0);
  });

  test('locks on return when idle time before and while hidden adds up past the idle limit', async () => {
    const { client, state } = fakeClient();
    teardown = setupAutoLock(client);
    setSystemTime(new Date('2026-10-23T12:04:30Z'));
    setHidden(true);
    setSystemTime(new Date('2026-10-23T12:05:30Z'));
    setHidden(false);
    await flush();
    expect(state.locks).toBe(1);
  });
});
