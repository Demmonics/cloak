# Cloak Interrupted Session Recovery Audit & Architecture Alignment

**Date:** 2026-11-12  
**Branch:** `recovery/p2p-desktop` (checkpoint commit on `main`: `5bda6eb`)  

---

## 1. Repository Condition at Recovery

Upon resuming after the unexpected shutdown:

- **Preserved files:** 120 project source, schema, config, and documentation files were intact on disk with zero `node_modules/`, `target/`, or `.cloak-dev/` state tracked in Git.
- **Data preservation action:** Removed an accidental empty/stray file (`cloak_dev_pass_2026`) at the workspace root, committed the pre-shutdown state on `main` (`5bda6eb`: `chore(recovery): checkpoint pre-shutdown Cloak workspace state (120 files)`), added `.gitattributes` (enforcing LF on source/SQL and CRLF on `.ps1`/`.bat`), and branched `recovery/p2p-desktop`.
- **Host toolchain facts verified:**
  - Rust `stable-x86_64-pc-windows-gnu` with MinGW `gcc 15.2.0` is available and required (MSVC `link.exe` is not installed).
  - Node.js / npm workspaces and TypeScript build cleanly.
  - PostgreSQL 18.6 is installed locally (run on `127.0.0.1:55432` for dev/E2E because host PID `10584` occupies `0.0.0.0:8080`).
  - Microsoft Edge WebView2 runtime is installed (`C:\Program Files (x86)\Microsoft\EdgeWebView\Application`).
  - Docker, `redis-server`, `livekit-server`, and `cargo-tauri` CLI are not installed on this host.

---

## 2. Reconstructed Architecture & Gap Audit (Pre-Recovery Web/Server Stack)

### Implemented & Reused Modules (Verified)
| Layer | Path | Status & Capability |
|---|---|---|
| Protocol & Wire Types | `packages/protocol` | Shared TypeScript DTOs, WebSocket frames, export manifest schemas |
| Shared Config & Constants | `packages/config` | Client limits, disappearing message presets, API/WS base URL helpers |
| Client Cryptography | `packages/crypto` | `libsodium-wrappers-sumo`: Ed25519 identity, X25519 key exchange, XChaCha20-Poly1305 message & chunk stream AEAD, Argon2id key derivation |
| Encrypted Archive Engine | `packages/archive` | `.cloakexport` (`CLOAKEXP\x01\x00` + Argon2id + secretstream XChaCha20-Poly1305) & AES-256 ZIP builders/readers, offline safe HTML/JSON/TXT formatters, zip-slip / filename path validators |
| Design System | `packages/ui` | Dark Discord-class accessible components (`Button`, `Avatar`, `ModalDialog` native `<dialog>`, `ToastRegion` top-layer popover, `Skeleton`) |
| Web Frontend & Offline Vault | `apps/web` | React 19 + Tailwind CSS + Dexie IndexedDB vault + Web Worker `.cloakexport` builder + MiniSearch local encrypted search + `/archive` offline viewer + LiveKit E2EE media controller |
| Rust Relay / Server Stack | `services/core`, `services/api`, `services/worker` | Axum + SQLx (PostgreSQL) zero-knowledge ciphertext API/WS relay + retention sweep worker (preserved cleanly for optional self-hosted mode) |

### Defects Found & Fixed During Recovery Verification
1. **Typecheck failures (`apps/web/src/lib/workspaceClient.ts`):** 3 message body objects (`sendEncryptedMessage`, `retryFailedMessage`, `editEncryptedMessage`) omitted `version: 1`. Fixed.
2. **UI CSS import & lint configs (`apps/web/src/main.tsx`, root configs):** Fixed `@cloak/ui/styles.css` import, added `eslint.config.mjs`, `vitest.config.mts`, `playwright.config.ts`, and resolved lint issues across `archive`, `crypto`, `WorkspacePage`, `InviteModal`, and `ForwardAndBurnModals`.
3. **Rust Clippy & SQLx migration state (`services/*`):** Recreated local dev DB after migration checksum drift and fixed 6 `clippy::collapsible_if` lints.
4. **Live Invite State Leaks (`InviteModal.tsx`, `InviteLandingPage.tsx`):** Cleared stale invite URLs on re-generation and reset route state when invite token params changed.
5. **Async Markdown Sanitizer Bug (`apps/web/src/components/MessageList.tsx`, `apps/web/src/lib/sanitizeHtml.ts`):** `SanitizedMarkdown` called `async sanitizeUntrustedHtml(...)` inside `useMemo`, rendering `[object Promise]` instead of decrypted text! Added synchronous cache-backed `trySanitizeUntrustedHtmlSync` + safe escaped fallback & async hydration.
6. **Responsive & Visual QA Issues (`packages/ui/src/styles.css`, `MessageComposer.tsx`, `WorkspacePage.tsx`, `ExportChatModal.tsx`, `OnboardingScreen.tsx`):**
   - Fixed `"Open Archive"` badge wrap on onboarding.
   - Repositioned toast notifications from bottom-right to top-right (`top: 3.75rem`) so toasts never cover the composer Send button or timer dropdown.
   - Added responsive flex ordering in `MessageComposer` so `<textarea>` gets full width at `390x844` mobile instead of getting crushed.
   - Adjusted mobile channel header overflow and concise `.cloakexport` option text so no labels truncate or hide `#channel`.

### Remaining Architectural Gap vs. Authoritative Phase 3 Requirement
The pre-recovery stack (`apps/web` + `services/api` + PostgreSQL + Redis + LiveKit) was strictly **client-server browser-first**. It required a running backend API and PostgreSQL database to store ciphertext rooms/messages/attachments, and did not provide:
- A fast native Windows Rust desktop binary
- Embedded local SQLite (`rusqlite`) + local attachment blob persistence
- Direct encrypted peer-to-peer communication between two computers without a mandatory central messaging server or cloud storage
- Explicit `DirectOnly` vs `Assisted` NAT/firewall reporting with strict guarantee against silent relaying

---

## 3. Target Unified Local-First P2P Desktop Architecture (`Phase 3` & `Phase 8`)

Without discarding the preserved web & optional server relay stack, we extend the Rust workspace with two native crates:

1. **`crates/cloak-p2p` (Local-First P2P Core Library):**
   - **Persistence (`rusqlite` bundled SQLite + local filesystem blob store):** Local device identity keys (`Ed25519` + `X25519`), paired peers, rooms/channels, encrypted messages, offline outbox queue, deletion tombstones (`everyone` / `device` / `cleared` / `burned`), disappearing message TTLs, and chunked attachment metadata + encrypted chunk files.
   - **Direct Encrypted Peer-to-Peer Wire Protocol (`tokio` TCP framed transport):**
     - Authenticated handshake using mutual `Ed25519` signatures over transcript + ephemeral `X25519` key exchange + `XChaCha20-Poly1305` bidirectional session keys (every wire payload stays ciphertext + authenticated).
     - Connectivity mode policy: `ConnectivityMode::DirectOnly` (direct peer IP/port only; never contacts rendezvous/relay and returns explicit NAT/firewall diagnostic errors if unreachable) and `ConnectivityMode::Assisted` (explicitly opt-in rendezvous/STUN/relay metadata mode).
     - Automatic outbox synchronization on reconnect, edit & tombstone propagation, local TTL expiry purge, direct chunked SHA-256 verified attachment transfer, and direct P2P WebRTC SDP/ICE signaling frames over the encrypted peer channel.
   - **Benchmark & Multi-Peer Test Coverage:** Real dual-peer localhost/LAN TCP integration tests + release startup, SQLite write/query, and P2P message/file throughput benchmarks.

2. **`apps/desktop` (Native Windows Desktop Binary `cloak-desktop.exe`):**
   - Single fast-starting Rust executable embedding the compiled `apps/web/dist` assets (`include_dir`), launching the embedded local-first loopback daemon (`127.0.0.1:<ephemeral>`) wired directly to `crates/cloak-p2p` (SQLite + direct P2P TCP listener/connector + WebSocket live push + WebRTC P2P signaling + `.cloakexport` compatible local archive access), and opening a dedicated native Windows Edge WebView2 (`msedgewebview2` / Edge `--app=` app-mode window or `wry` if GNU build cleanly supports it — documented accurately after verification).
   - Preserves clean frontend support inside `apps/web` for P2P Peer Pairing / Direct Address Tickets alongside optional server rooms.

---

## 4. Verification Baseline Going Into Phase 3/8 Implementation

- `npm run typecheck`: Passing
- `npm run lint`: Passing
- `npm run test:unit`: 3 suites / 15 tests passing
- `npm run build`: Passing (`apps/web/dist` built in ~550ms)
- `npm run test:e2e`: Passing (1 full two-browser Playwright scenario passing cleanly in 18.4s; all 6 screenshots captured in `docs/visual-qa/` and visually verified)
- `cargo fmt --check`, `cargo clippy`, `cargo test --workspace`: Passing (`cloak-api`, `cloak-core`, `cloak-worker`)

