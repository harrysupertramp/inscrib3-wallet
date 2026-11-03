import { createApp } from 'vue';
import { WalletApp, WALLET_CLIENT_KEY } from '@inscrib3/ui';
import { createPwaWalletClient } from './pwa-wallet-client.js';
import { setupAutoLock } from './auto-lock.js';
import ConnectApp from './ConnectApp.vue';
import UpdateBanner from './UpdateBanner.vue';
import type { PopupRequest } from './popup-request.js';

// The opener controls the URL params, so they only pick the request type.
// document.referrer is the trusted origin; no referrer fails closed.
function verifiedOpenerOrigin(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

function parsePopupRequest(): PopupRequest | null {
  const params = new URLSearchParams(window.location.search);
  const origin = verifiedOpenerOrigin();
  if (!origin) return null;

  if (params.has('arkade_connect_origin')) {
    return { type: 'connect', origin };
  }

  const sendAddress = params.get('arkade_send_address');
  const sendAmountRaw = params.get('arkade_send_amount');
  if (params.has('arkade_send_origin') && sendAddress && sendAmountRaw) {
    const amount = Number(sendAmountRaw);
    if (Number.isFinite(amount) && amount > 0) {
      return { type: 'send', origin, address: sendAddress, amount };
    }
  }

  return null;
}

// *.github.io is one origin shared by every Pages site on an account, so any
// of them could read this wallet's storage and script its page.
if (location.hostname.endsWith('.github.io')) {
  document.body.textContent = 'This wallet must be served from its own domain, not *.github.io.';
  throw new Error('Refusing to run on a shared github.io origin');
}

const request = parsePopupRequest();
const isPopupMode = !!request && !!window.opener;

const app = isPopupMode ? createApp(ConnectApp, { request: request! }) : createApp(WalletApp);
const client = createPwaWalletClient();
app.provide(WALLET_CLIENT_KEY, client);
app.mount('#app');

// Popup mode closes itself after approval: no auto-lock or update banner.
if (!isPopupMode) {
  setupAutoLock(client);
  createApp(UpdateBanner).mount('#update-banner');
}

export default app;
