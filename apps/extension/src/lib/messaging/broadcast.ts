import type { ArkadeEventName, PageEvent, UiOnlyEventName } from './protocol.js';

// tabs.sendMessage reaches content scripts and runtime.sendMessage reaches
// our own windows; both are needed. content.ts filters origin-scoped events.
export async function broadcastEvent(event: ArkadeEventName, data?: unknown, origin?: string): Promise<void> {
  const payload: PageEvent = { _arkadeEvent: true, event, data, origin };
  const tabs = await browser.tabs.query({});

  await Promise.all([
    ...tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await browser.tabs.sendMessage(tab.id, payload);
      } catch {
        // no content script in this tab
      }
    }),
    browser.runtime.sendMessage(payload).catch(() => {
      // no extension window open
    }),
  ]);
}

// Never sent to tabs: these carry amounts no page should see.
export async function notifyUi(event: UiOnlyEventName, data?: unknown): Promise<void> {
  const payload: PageEvent = { _arkadeEvent: true, event, data };
  await browser.runtime.sendMessage(payload).catch(() => {
    // no popup open
  });
}
