import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';

// Keys live in this page's JS context, so no script may load from anywhere
// else. connect-src stays open to any https/wss host because the Ark server
// and Esplora URLs are user-configurable and swap providers use nostr relays.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Build only: the dev server relies on inline scripts and ws:// for HMR.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  };
}

export default defineConfig({
  // The one .env (gitignored, shared with apps/extension) is at the repo root.
  envDir: '../..',
  plugins: [
    contentSecurityPolicy(),
    vue(),
    VitePWA({
      // 'prompt', not 'autoUpdate': a redeploy must not swap the app out mid-send.
      registerType: 'prompt',
      // The main bundle is the app itself; it must stay in the offline cache.
      workbox: { maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
      manifest: {
        name: 'Inscrib3',
        short_name: 'Inscrib3',
        description: 'Bitcoin wallet for the Ark protocol',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
