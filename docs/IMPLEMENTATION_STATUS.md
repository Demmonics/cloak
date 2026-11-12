# Cloak Implementation Status

**Branch:** `recovery/p2p-desktop`  
**Base Checkpoint:** `main` (`5bda6eb`)  
**Updated:** 2026-11-12  

---

## 1. Native Local-First Peer-to-Peer Desktop Core (`Phase 9`)

| Component | Path | Status |
|---|---|---|
| Core P2P Engine & Cryptography | `crates/cloak-p2p` (`crypto.rs`, `transport.rs`, `storage.rs`, `model.rs`, `netinfo.rs`, `ghost.rs`) | Implemented & verified (`6/6` `cloak-p2p` tests passing): Ed25519 mutual handshake, X25519 ephemeral DH + HKDF-SHA-256, mutual HMAC transcript ack, counter-nonce `XChaCha20-Poly1305` frames + FIFO session rekeying, inbound peer key-pinning, Win32 DPAPI field sealing (`CryptProtectData`/`CryptUnprotectData`), Argon2id PIN hashing, LAN/IPv6 interface detection (`primaryLanIp`). |
| Native WebView2 Desktop Shell | `apps/desktop` (`main.rs`, `native_shell.rs`, `server.rs`, `capture.rs`, `assets.rs`) | Implemented & verified (`1/1` `cloak-desktop` test passing; live OS HWND + GUI verified): `tao` + `wry` embedded WebView2 window, tray icon & menu (`Show` / `Lock` / `Quit`), `rfd` native file dialogs, embedded `.ico`, Win32 `WM_ACTIVATEAPP` subclassing, `SW_MINIMIZE`, `WTSRegisterSessionNotification` (`WM_WTSSESSION_CHANGE`), `SetWindowDisplayAffinity`, loopback bearer-token + Origin/Host API guard, Win32 `EnumWindows` / `PrintWindow` / `StretchBlt` BMP screen/window capture bridge. `--headless` and `--edge-app` fallback modes retained. |
| Ghost Mode Privacy Engine | `crates/cloak-p2p/src/ghost.rs`, `storage.rs`, `transport.rs` | Implemented & tested (`cloak-p2p` unit tests + Playwright `Spec 2` + Win32 `WM_ACTIVATEAPP`/`SW_MINIMIZE` checks): `off`, `privacy_shield`, `clear_viewed`, `clear_open_conversation` (with explicit confirmation), per-room overrides, `local_suppressions` anti-resurrection tombstone table, viewport dwell `IntersectionObserver`, `in_app_modal_depth` guard, disappearing presets (`on_leave`, `after_view:30`, `after_view:300`, timed). |
| Windows Installer & Packaging | `apps/desktop/src/bin/cloak_setup.rs`, `scripts/package-windows.ps1` | Implemented & verified on host OS: self-extracting `Cloak-Setup-x64.exe` (`19.12 MiB`), `cloak-desktop.exe` (`17.79 MiB`), `Cloak-Portable-win64.zip` (`5.92 MiB`), `SHA256SUMS.txt`. Silent install, Start Menu/Desktop `.lnk` shortcuts, `HKCU\...\Uninstall\CloakDesktop` registration, and silent `--uninstall --keep-data` verified clean with zero leftovers. |
| P2P Desktop Frontend & WebRTC Stage | `apps/web/src/lib/p2pClient.ts`, `apps/web/src/pages/P2pWorkspacePage.tsx`, `apps/web/src/components/p2p/P2pGhostSettingsModal.tsx`, `apps/web/src/components/p2p/P2pMediaDock.tsx` | Implemented & Playwright-verified (`3/3` E2E specs passing): session token bootstrap & stripping from URL hash, multi-interface `cloakp2p://` pairing, direct encrypted messaging & search, SHA-256 attachments, `.cloakexport` download, Ghost settings modal & Privacy Shield PIN overlay, two-peer direct `RTCPeerConnection` voice/video (`RX` stats, `<video>` playback, `setSinkId`, early ICE candidate queue, `getDisplayMedia` + native Win32 capture bridge). |

---

## 2. Optional Self-Hosted Server / Browser Stack (Preserved)

| Component | Path | Status |
|---|---|---|
| Shared TypeScript Packages | `packages/protocol`, `packages/config`, `packages/crypto`, `packages/archive`, `packages/ui` | Maintained cleanly (`typecheck`, `lint`, `12/12` Vitest tests across `crypto` and `archive` passing). `ModalDialog` extended with fixed `footer` slot. |
| Web Workspace & `/archive` | `apps/web` | Built cleanly via Vite + Workbox (`dist/sw.js`); composer & export component tests passing (`3/3`). |
| Rust Relay Services & Infra | `services/core`, `services/api`, `services/worker`, `infrastructure/*` | Preserved in workspace (`cargo test --workspace` was reported passing in prior recovery baseline; Phase 9 focused testing on `-p cloak-p2p -p cloak-desktop`). |
