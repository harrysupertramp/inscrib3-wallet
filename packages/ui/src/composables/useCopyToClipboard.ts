import { ref } from 'vue';

// wipeAfterMs: clear the clipboard after this delay - for seed phrases only.
export function useCopyToClipboard(resetDelayMs = 2000, wipeAfterMs?: number) {
  const copied = ref(false);

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, resetDelayMs);
      if (wipeAfterMs !== undefined) {
        setTimeout(() => void wipeIfUnchanged(text), wipeAfterMs);
      }
    } catch {
      // permission denied - the text is still visible to copy by hand
    }
  }

  // Only clears if the clipboard still holds what we wrote.
  async function wipeIfUnchanged(expected: string): Promise<void> {
    try {
      const current = await navigator.clipboard.readText();
      if (current === expected) {
        await navigator.clipboard.writeText('');
      }
    } catch {
      // read permission denied
    }
  }

  return { copied, copy };
}
