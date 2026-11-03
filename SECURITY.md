# Security Policy

Inscrib3 is a non-custodial wallet that holds real Bitcoin. Security issues here can mean direct loss of funds — please report responsibly rather than filing a public issue.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](../../security/advisories/new) for this repo (Security tab → "Report a vulnerability"). This opens a private conversation with the maintainer and isn't visible publicly until resolved.

If you can't use that for some reason, see [SUPPORT.md](SUPPORT.md) for a direct contact.

Please include:
- What component is affected (extension, PWA, `packages/core`, `packages/ui`)
- Steps to reproduce, or a PoC if you have one
- What an attacker could actually do with it (e.g. drain funds, exfiltrate a seed, forge an approval)

## Scope

In scope: the browser extension, the PWA, and the shared `packages/core`/`packages/ui` code in this repo — key generation/storage, the approval/messaging layer between a dApp and the wallet, transaction signing, and network communication with an Ark server.

Out of scope: the Ark protocol/server itself, the `@arkade-os/sdk` dependency, and third-party services (e.g. the Satora and Arkade RFQ Lightning swap providers) — report those upstream.

## Supported versions

Only the latest release is supported. This project doesn't backport fixes to older versions.

## Disclosure

No bug bounty — this is an independent, unfunded project. Please give a reasonable amount of time to fix an issue before any public disclosure.
