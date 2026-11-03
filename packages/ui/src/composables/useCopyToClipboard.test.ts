import { describe, expect, test, afterEach } from 'bun:test';
import { useCopyToClipboard } from './useCopyToClipboard.js';

const originalClipboard = navigator.clipboard;
afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function stubClipboardWithRead(initial = '') {
  let value = initial;
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        value = text;
      },
      readText: async () => value,
    },
    configurable: true,
  });
  return {
    setExternally: (text: string) => {
      value = text;
    },
    get: () => value,
  };
}

describe('useCopyToClipboard', () => {
  test('copies the text and flips copied to true, then back to false after the delay', async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const { copied, copy } = useCopyToClipboard(10);

    expect(copied.value).toBe(false);
    await copy('hello');
    expect(written).toEqual(['hello']);
    expect(copied.value).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(copied.value).toBe(false);
  });

  test('stays false and does not throw when the clipboard API rejects (e.g. permission denied)', async () => {
    stubClipboard(async () => {
      throw new Error('permission denied');
    });
    const { copied, copy } = useCopyToClipboard(10);
    await expect(copy('hello')).resolves.toBeUndefined();
    expect(copied.value).toBe(false);
  });

  test('wipes the clipboard after wipeAfterMs when it still holds what we wrote', async () => {
    const clipboard = stubClipboardWithRead();
    const { copy } = useCopyToClipboard(10, 20);

    await copy('seed words here');
    expect(clipboard.get()).toBe('seed words here');

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(clipboard.get()).toBe('');
  });

  test('does not wipe if the clipboard content changed in the meantime', async () => {
    const clipboard = stubClipboardWithRead();
    const { copy } = useCopyToClipboard(10, 20);

    await copy('seed words here');
    clipboard.setExternally('something else the user copied');

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(clipboard.get()).toBe('something else the user copied');
  });

  test('never wipes when wipeAfterMs is not passed', async () => {
    const clipboard = stubClipboardWithRead();
    const { copy } = useCopyToClipboard(10);

    await copy('some address');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(clipboard.get()).toBe('some address');
  });
});
