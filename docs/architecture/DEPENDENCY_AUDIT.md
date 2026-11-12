# Dependency Audit (Verified Against npm & crates.io)

## Frontend & Shared TypeScript Packages
| Package | Version | Role | Security / Compatibility Notes |
| --- | --- | --- | --- |
| `react` / `react-dom` | `19.3.1` | UI runtime | Strict TypeScript types via `@types/react@19.3.0` |
| `typescript` | `~6.0.3` | Strict type checking | Pinned `<6.1.0` to satisfy `typescript-eslint@8.72.2` peer dependency |
| `vite` / `@vitejs/plugin-react` | `8.3.8` / `6.3.0` | Bundler & dev server | Supports Web Workers and ES modules |
| `tailwindcss` / `@tailwindcss/vite` | `4.3.5` | Styling | Dark-mode tokens and reduced-motion utilities |
| `zustand` | `5.1.0` | Client interaction state | Ephemeral keys, UI, call & sync state |
| `@tanstack/react-query` | `5.107.1` | Server-state cache | Fetches encrypted payloads only; never persisted plaintext |
| `@tanstack/react-virtual` | `3.14.26` | Message virtualization | Handles 10,000+ messages smoothly |
| `react-router` | `8.5.1` | Client routing | Routes `/`, `/rooms/:roomId`, `/invite/:token`, `/archive` |
| `framer-motion` | `14.12.0` | Restrained motion | Wrapped in `<MotionConfig reducedMotion="user">` |
| `lucide-react` | `1.72.0` | Vector icons | Tree-shaken, accessible `aria-hidden` decorative icons |
| `dexie` | `4.4.7` | IndexedDB offline cache | Stores ciphertext/key-wrapped local state only when unlocked |
| `libsodium-wrappers-sumo` | `0.8.4` | Audited cryptography | Full libsodium WASM: Argon2id, XChaCha20-Poly1305, secretstream, Ed25519, X25519 |
| `@zip.js/zip.js` | `2.24.0` | Streaming ZIP engine | Streaming ZIP inner container + optional AES-256 ZIP (never ZipCrypto) |
| `livekit-client` / `@livekit/components-react` | `2.23.0` / `2.9.25` | WebRTC SFU & E2EE | Supports `ExternalE2EEKeyProvider` frame encryption |
| `dompurify` | `3.4.17` | HTML sanitization | Fallback alongside native Sanitizer API (`setHTML`) |
| `marked` | `18.2.0` | Markdown parser | Output always sanitized before DOM insertion |
| `minisearch` | `7.2.0` | Client-side full-text index | Operates purely in-memory over authorized decrypted messages |
| `vite-plugin-pwa` | `2.0.0` | PWA manifest & SW | NetworkOnly for `/api/*`; offline shell + `/archive` reader |
| `vitest` / `@playwright/test` | `5.1.0` / `1.65.0` | Unit & E2E testing | Real multi-browser Chromium verification |

## Rust Backend (`services/core`, `services/api`, `services/worker`)
| Crate | Version | Role | Notes |
| --- | --- | --- | --- |
| `axum` | `0.8.9` | HTTP & WebSocket server | Typed extractors, WS upgrades |
| `tokio` | `1.54.1` | Async runtime | Multi-threaded IO & background tasks |
| `sqlx` | `0.9.0` | PostgreSQL driver & migrations | Runtime-tokio + rustls + postgres + migrate + uuid + chrono |
| `redis` | `1.8.1` | Distributed state | Stable 1.x release; presence, pubsub, rate limiting |
| `tower-http` | `0.7.1` | Middleware | CORS, request size limits, security headers, tracing |
| `jsonwebtoken` | `10.3.0` | Session & LiveKit JWTs | RustCrypto backend; no OpenSSL host dependency |
| `ed25519-dalek` | `2.2.0` | Device signature verification | Verifies Ed25519 auth challenges without passwords |
| `argon2` | `0.5.3` | Server-side invite password gate | Independent from client E2EE key derivation |
| `sha2` / `hmac` / `subtle` | `0.10.9` / `0.12.1` / `2.6.1` | Token hashing & SigV4 | Constant-time comparisons & AWS SigV4 signing |
| `reqwest` | `0.12.24` | S3 & LiveKit HTTP calls | Pure `rustls-tls`; avoids native OpenSSL build issues on Windows |

