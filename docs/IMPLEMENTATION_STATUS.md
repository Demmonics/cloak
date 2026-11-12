# Cloak Implementation Status

**Branch:** `recovery/p2p-desktop`  
**Base Checkpoint:** `main` (`5bda6eb`)  
**Updated:** 2026-11-12  

---

## 1. Phase 10 Stealth Mode, Offline PDF Decoy & Privacy Automation

| Component | Path | Status |
|---|---|---|
| Stealth Engine, Secret Unlock & Timers | `crates/cloak-p2p` (`stealth.rs`, `stealth_controller.rs`, `stealth_storage.rs`, `stealth_tests.rs`) | Implemented & verified (`4/4` `stealth_tests` passing): launch view (`messenger`/`pdf_reader`), salted Argon2id secret codes (with multi-action dispatch, Unicode support, case sensitivity toggle, optional 2FA step-up, recovery key, and SQLite-persisted progressive cooldowns in `stealth_rate_limit`), WinRT `UserConsentVerifier` probe, Background-Away / Foreground-Idle / System-Idle timers (`stealth_runtime_checkpoint` overdue recovery + deterministic clock testing), declarative `WHEN [Trigger] -> PERFORM [Actions]` rule engine + non-destructive Test Mode preview. |
| Route Isolation & Desktop Loopback API | `apps/desktop/src/server.rs`, `apps/desktop/src/native_shell.rs` | Implemented & verified (`2/2` `cloak-desktop` Rust tests + live Win32 HWND verification): `require_unlocked_stealth` (`423 Locked` on private routes while Stealth is locked), `locked_safe_routes`, WebSocket auto-reconnect + `stealth_state_changed` event push, Win32 `GetLastInputInfo` OS idle reporting, `SetWindowDisplayAffinity` (`0x11` `WDA_EXCLUDEFROMCAPTURE`), dynamic Win32 window title & tray tooltip updates (`Document Reader` on lock/minimize). |
| Offline PDF.js v6 Decoy Shell | `apps/web/src/components/pdf/PdfReaderShell.tsx` | Implemented & Playwright-verified (`externalRequests === []`): local worker bundling (`pdf.worker.min.mjs`), `%PDF-` header validation, Light/Dark themes, Pages/Outline/Saved/Library tabs, multi-tab PDF library (`pdf_library`), zoom/rotate/bookmarks persistence, `Document Properties` SHA-256 popover, in-document text search + PDF search unlock, neutral `Audio Session Active` call badge. |
| 6-Tab Privacy, Stealth & Ghost Settings Modal | `apps/web/src/components/stealth/P2pStealthSettingsModal.tsx` | Implemented & Visual-QA verified across 16 screenshots (`docs/visual-qa/stealth-mode/`): `Appearance`, `Unlock & Codes`, `Triggers & Timers`, `Actions, Calls & Notices`, `Ghost Mode`, and `Rules & Test Mode` (plus non-destructive preview sandbox). |

---

## 2. Native Local-First Peer-to-Peer Desktop Core (`Phase 9`)

| Component | Path | Status |
|---|---|---|
| Core P2P Engine & Cryptography | `crates/cloak-p2p` (`crypto.rs`, `transport.rs`, `storage.rs`, `model.rs`, `netinfo.rs`, `ghost.rs`) | Implemented & verified (`10/10` total `cloak-p2p` tests passing): Ed25519 mutual handshake, X25519 ephemeral DH + HKDF-SHA-256, mutual HMAC transcript ack, counter-nonce `XChaCha20-Poly1305` frames + FIFO session rekeying, inbound peer key-pinning, Win32 DPAPI field sealing (`CryptProtectData`/`CryptUnprotectData`), Argon2id PIN hashing, LAN/IPv6 interface detection (`primaryLanIp`). |
| Native WebView2 Desktop Shell | `apps/desktop` (`main.rs`, `native_shell.rs`, `server.rs`, `capture.rs`, `assets.rs`) | Implemented & verified (`cloak-desktop.exe` `20.9 MiB`): `tao` + `wry` embedded WebView2 window, tray icon & menu (`Show` / `Switch to PDF Cover` / `Lock` / `Quit`), `rfd` native file dialogs, embedded `.ico`, Win32 `WM_ACTIVATEAPP`, `SW_MINIMIZE`, `WTSRegisterSessionNotification` (`WM_WTSSESSION_CHANGE`), `SetWindowDisplayAffinity`, loopback bearer-token + Origin/Host API guard, Win32 screen/window capture bridge. `--headless` and `--edge-app` fallback modes retained. |
| Ghost Mode Privacy Engine | `crates/cloak-p2p/src/ghost.rs`, `storage.rs`, `transport.rs` | Implemented & tested (`cloak-p2p` unit tests + Playwright `Spec 2` & `stealth-mode.spec.ts`): `off`, `privacy_shield`, `clear_viewed`, `clear_open_conversation`, per-room overrides, `local_suppressions` anti-resurrection tombstone table, viewport dwell `IntersectionObserver`, `in_app_modal_depth` guard, disappearing presets (`on_leave`, `after_view:30`, `after_view:300`, timed). |
| Windows Installer & Packaging | `apps/desktop/src/bin/cloak_setup.rs`, `scripts/package-windows.ps1` | Verified via `scripts/package-windows.ps1`: `Cloak-Setup-x64.exe` (`22.23 MiB`), `cloak-desktop.exe` (`20.9 MiB`), `Cloak-Portable-win64.zip` (`6.71 MiB`), `SHA256SUMS.txt`. |
| P2P Desktop Frontend & WebRTC Stage | `apps/web/src/lib/p2pClient.ts`, `apps/web/src/pages/P2pWorkspacePage.tsx`, `apps/web/src/components/p2p/P2pGhostSettingsModal.tsx`, `apps/web/src/components/p2p/P2pMediaDock.tsx` | Implemented & Playwright-verified (`4/4` combined E2E specs passing across `p2p-desktop.spec.ts` + `stealth-mode.spec.ts`): session token bootstrap, WebSocket auto-reconnect, HTTP 423 lock-safe handling, `cloakp2p://` pairing, direct encrypted messaging & search, SHA-256 attachments, `.cloakexport` download, Ghost/Stealth settings UI, two-peer direct `RTCPeerConnection` voice/video (`RX` stats, `<video>` playback, `setSinkId`, early ICE candidate queue, `getDisplayMedia` + native Win32 capture bridge). |

---

## 3. Optional Self-Hosted Server / Browser Stack (Preserved)

| Component | Path | Status |
|---|---|---|
| Shared TypeScript Packages | `packages/protocol`, `packages/config`, `packages/crypto`, `packages/archive`, `packages/ui` | Maintained cleanly (`typecheck`, `lint`, `12/12` Vitest tests across `crypto` and `archive` passing). |
| Web Workspace & `/archive` | `apps/web` | Built cleanly via Vite + Workbox (`dist/sw.js`, `pdf.worker.min.mjs`); `ComposerAndExport.test.tsx` (`3/3` passing). |
| Rust Relay Services & Infra | `services/core`, `services/api`, `services/worker`, `infrastructure/*` | Preserved in workspace; `cargo clippy --all-targets -- -D warnings` passes cleanly across all targets. |
