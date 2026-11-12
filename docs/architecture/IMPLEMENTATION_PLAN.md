# Cloak Implementation Plan & Phase Architecture

## 1. Environment Findings & Local Execution Strategy
- **Workspace state:** Clean repository initialized on `main`.
- **Host toolchain verified:**
  - `node v24.18.0`, `npm 11.16.0`
  - `rustc 1.99.1` (`stable-x86_64-pc-windows-gnu`) with MinGW-W64 `gcc 15.2.0`
  - `PostgreSQL 18.6` (`initdb.exe`, `pg_ctl.exe`, `psql.exe`, `createdb.exe` on local host; project-local cluster on `127.0.0.1:55432`)
  - Playwright Chromium (`chromium-1248`) installed in `%LOCALAPPDATA%\ms-playwright`
- **External services not installed as host daemons on Windows:** Docker Desktop, Redis, MinIO, and `livekit-server` are absent on this host.
  - **Production / Self-Hosting:** Complete Docker Compose stack (`postgres:18`, `redis:7`, `minio`, `livekit-server`, `caddy`, `cloak-api`, `cloak-worker`, `cloak-web`) is provided in `infrastructure/docker/`.
  - **Local Dockerless Execution & Testing:**
    - Real PostgreSQL 18.6 runs locally in `.cloak-dev/pgdata`.
    - `CLOAK_ENV=production` fails closed unless `REDIS_URL`, `S3_ENDPOINT`, and `LIVEKIT_URL` are configured and reachable.
    - When `CLOAK_ENV != production` and `CLOAK_DEV_ALLOW_IN_MEMORY_REDIS=true` / `OBJECT_STORE_BACKEND=local`, single-node in-memory rate-limit/presence and local ciphertext-only disk blob storage allow full end-to-end verification of HTTP, WebSocket, encryption, attachments, deletion, and `.cloakexport` without mocks in production code paths.

## 2. Monorepo Layout
- `apps/web` — React 19 + TypeScript strict + Vite 8 + Tailwind CSS v4 + PWA + Web Workers
- `packages/protocol` — Shared v1 HTTP/WS contracts, roles/permissions, attachment states, export manifest types
- `packages/crypto` — Audited libsodium (`libsodium-wrappers-sumo`) primitives, key generation, X25519 epoch envelopes, XChaCha20-Poly1305 message & invite wrapping, secretstream file encryption, encrypted `.cloakkey` backup
- `packages/archive` — Streaming `.cloakexport` v1 container encoder/decoder, `@zip.js/zip.js` inner ZIP builder, AES-256 ZIP fallback, offline static HTML/CSS generator, decompression-bomb/path-traversal/XSS validator
- `packages/ui` — Design tokens, native `<dialog>` modal & confirmation primitives, popover toast region, accessible controls
- `packages/config` — Environment validation, quotas, call presets, security constants
- `services/core` — Rust shared config, Ed25519 challenge/JWT auth, PostgreSQL migrations & repositories, Redis/dev state store, S3 SigV4/local object store, distributed rate limiter, LiveKit token & room client
- `services/api` — Axum v1 HTTP + WebSocket API server
- `services/worker` — Background retention, disappearing message expiration, and orphan ciphertext cleanup worker
- `infrastructure/` — Docker Compose, Dockerfiles, Caddyfile, LiveKit config
- `tests/` — Playwright E2E, security regressions, performance & archive validation
- `docs/` — ADRs, architecture, security threat model, deployment, browser compatibility, release readiness

## 3. Vertical Implementation Phases
1. **Phase 1 — Foundation:** Monorepo, SQLx migrations, Rust API + health/auth/rooms/invites, client cryptographic identity, dark-graphite UI shell, two-client room creation & invite join (`#k=` fragment).
2. **Phase 2 — Messaging:** Encrypted message send/edit/delete/react/pin/reply/thread/bookmark/forward, WebSocket realtime fanout, cursor sync, optimistic UI + idempotency, Dexie offline cache, MiniSearch local search, Markdown + sanitization, TanStack Virtual.
3. **Phase 3 — Privacy, Attachments & Export Engine:** Chunked secretstream encrypted uploads/downloads, quotas, drag-drop/paste/voice notes, full deletion & burn-room-history + epoch rotation, worker retention sweeps, `.cloakexport` v1 + AES-ZIP + offline Archive Reader (`/archive`) + full 25-case export test suite.
4. **Phase 4 — Voice, Video & Screen Sharing:** LiveKit JWT minting, `livekit-client` + `ExternalE2EEKeyProvider`, voice control dock (mute, deafen, PTT, VAD, per-participant volume, device test/select, noise/echo toggles), video grid/focus/pinning, screen share quality presets (720p30/1080p30/1080p60) & theater mode, channel switching without call disconnect.
5. **Phase 5 — Community Features:** Multi-channel & collapsible categories, read-only announcement channels, slow mode, roles/kick/ban (with epoch rotation), invite approval queue, right sidebar tabs, unread counts, PWA installability & offline shell (never caching plaintext API data).
6. **Phase 6 — Hardening, Docs & Release Gate:** Rate-limit & authorization regression tests, 10k-message & archive stress tests, accessibility & multi-browser Playwright verification, deployment & threat model documentation, truthful release-readiness report.

