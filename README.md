# Inscrib3

A non-custodial Bitcoin wallet for the [Ark protocol](https://arkade.money), shipped as both a browser extension and a PWA.

> **Experimental — use at your own risk.** This is early software that moves real Bitcoin. No warranties, no guaranteed support. Don't put in more than you can afford to lose.

## Features

- Fully non-custodial — your keys never leave your device.
- Send and receive over the Ark protocol (fast, low-fee, no full on-chain confirmation needed) and over Lightning via atomic swaps.
- On-chain in and out: receive to a boarding address and move it into Ark, or send to any Bitcoin address through a collaborative exit with the Ark server.
- Ark assets: view and send the assets your wallet holds.
- Multiple accounts and imported seeds under one password, coin control, auto-lock.
- Same wallet, two shells: a browser extension for dApp integration, and an installable PWA that needs no install step.
- Unilateral exit — you can always recover funds on-chain yourself, without the Ark server's cooperation. It is an emergency path: every off-chain step behind your coins has to be published on-chain, so fees can exceed a small balance. Settling first (one fresh VTXO) keeps it cheapest.

## Repo structure

Bun workspace monorepo:

```
packages/core   @inscrib3/core   Wallet logic, crypto, network settings — no UI, no platform APIs
packages/ui     @inscrib3/ui     Shared Vue screens (Setup/Unlock/Dashboard/Send/Receive/...)
apps/extension                   WXT browser extension (Manifest V3, Chrome + Firefox)
apps/pwa                         Vite + Vue PWA
```

Both apps mount the same `@inscrib3/ui` screens and talk to `@inscrib3/core`'s `WalletManager` through a shared `WalletClient` interface — the extension via message-passing to its background service worker, the PWA by holding a `WalletManager` directly in-process. Neither app knows about the other.

## Installing the extension

Grab the latest zip from this repo's [Releases](../../releases) page, then:

1. Go to `chrome://extensions` (or `brave://extensions`)
2. Enable Developer mode
3. Unzip the release, click "Load unpacked", select the folder

Chrome, Brave, and other Chromium browsers are supported. A Firefox build (`bun run build:firefox`) compiles but is untested and unpublished.

Each release also ships a `SHA256SUMS` file — check the zip against it before loading it (`shasum -a 256 -c SHA256SUMS`).

## Using the PWA

The PWA is deployed from this repo via GitHub Pages on every push to `main` — no install needed, just open the link. See this repo's About section for the URL.

It is only ever served from a dedicated custom domain (the `PWA_DOMAIN` repository variable): a `*.github.io` origin is shared by every Pages site on the account, so the deploy workflow and the app itself both refuse it.

## Development

Requires [Bun](https://bun.sh) 1.2.x (CI uses 1.2.9; Bun 1.4 fails on an ESM `require()` inside the SDK's dependencies).

```bash
bun install   # once, from the repo root
```

**PWA:**

```bash
cd apps/pwa
bun run dev         # dev server, http://localhost:5173
bun run build        # production build -> apps/pwa/dist
bun run typecheck
```

**Extension:**

```bash
cd apps/extension
bun run dev             # Chrome, hot-reloading dev build
bun run dev:firefox     # Firefox
bun run build           # production build -> apps/extension/.output/chrome-mv3
bun run build:firefox
bun run zip              # zips the build for store submission / a GitHub release
```

To load a dev/build output manually in Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked" → select `apps/extension/.output/chrome-mv3`.

From the repo root, `bun run typecheck`, `bun run test`, and `bun run build` cover both apps; `bun run e2e` runs the Playwright suite against a real built extension.

## Releases

Every push to `main` runs CI and, if it passes, publishes the extension as a GitHub Release and deploys the PWA (`.github/workflows/release.yml`). The version bumps itself: the patch number is one above the last release tag, and major/minor come from `apps/extension/package.json` — change that file to `0.2.0` to start the 0.2 series.

## Networks

Defaults to Bitcoin mainnet. A Mutinynet testnet preset is also available from Settings inside the app (or type any custom Ark server URL there) — useful for testing without real funds.

## Connecting a dApp

If the extension is installed, it injects `window.arkade` into every page:

```js
if (window.arkade) {
  const accounts = await window.arkade.connect();
  const txid = await window.arkade.sendToAddress(address, amountSats);
}
```

Without the extension, the PWA can be opened as a popup and will hand back a connect/send result via `postMessage` (same-browser only — see `apps/pwa/src/ConnectApp.vue` for the request handling). Ark addresses only for sends in this version; plain on-chain Bitcoin addresses aren't supported yet.

## Contributing / support

See [SUPPORT.md](SUPPORT.md) for how to reach out or contribute. Security issues: see [SECURITY.md](SECURITY.md) — please don't file those as public issues.

## License

[MIT](LICENSE)
