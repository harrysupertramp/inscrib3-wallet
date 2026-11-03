import { isPageMessage, isPageEvent, isArkadeEventName, toRpcRequest } from '../src/lib/messaging/protocol.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    let port: MessagePort | null = null;
    const queuedEvents: unknown[] = [];

    // Registered before page scripts run, so this answers injected.js's ready
    // signal; traffic then moves to a private MessagePort.
    window.addEventListener('message', function onReadySignal(event) {
      if (event.source !== window) return;
      const data = event.data as { _arkadeReady?: unknown } | null;
      if (!data || data._arkadeReady !== true) return;
      window.removeEventListener('message', onReadySignal);

      const channel = new MessageChannel();
      const messagePort = channel.port1;
      port = messagePort;
      messagePort.onmessage = (portEvent: MessageEvent) => {
        if (!isPageMessage(portEvent.data)) return;
        const request = toRpcRequest(portEvent.data.request);
        if (!request) return;
        browser.runtime.sendMessage(request).then((response) => {
          messagePort.postMessage({ _arkade: true, response });
        }).catch((e: unknown) => {
          messagePort.postMessage({ _arkade: true, response: { id: request.id, error: String(e) } });
        });
      };
      messagePort.start();
      window.postMessage({ _arkadeInit: true }, window.location.origin, [channel.port2]);

      // Flush events broadcast while the handshake was in flight.
      for (const message of queuedEvents.splice(0)) messagePort.postMessage(message);
    });

    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/injected.js');
    script.type = 'module';
    (document.head ?? document.documentElement).prepend(script);
    script.addEventListener('load', () => script.remove());

    // Events go to every tab, so an origin-scoped one (accountsChanged carries
    // an address) is only relayed into a page with the matching origin.
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isPageEvent(message)) return;
      // Popup-only events must never reach a page, even if delivery changes.
      if (!isArkadeEventName(message.event)) return;
      if (message.origin !== undefined && message.origin !== window.location.origin) return;
      if (port) port.postMessage(message);
      else queuedEvents.push(message);
    });
  },
});
