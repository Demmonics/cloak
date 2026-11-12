# Cloak — Phase 11 Security Audit & Hardening Findings

**Date:** 2026-11-12  
**Branch:** `recovery/p2p-desktop`  
**Audit Method:** Direct line-by-line inspection and live API/filesystem/Win32 probing across `crates/cloak-p2p`, `apps/desktop`, and `apps/web`.

---

## 1. Vulnerabilities & Defects Discovered and Fixed in Phase 11

### [HIGH-01] Production Exposure of `/p2p/v1/stealth/test-clock-advance` (FIXED)
- **Prior Behavior:** `apps/desktop/src/server.rs` mounted `POST /p2p/v1/stealth/test-clock-advance` inside `locked_safe_routes` unconditionally in release binaries. Any caller with the loopback token (or an injected renderer script) could jump `StealthController::test_clock_offset_ms` forward arbitrarily—bypassing rate-limit lockout timers (`rate_limit` checks `self.now_ms()`) or prematurely tripping timed `DeleteViewedLocal` / `DeleteActiveConversation` away-timer wipes.
- **Fix Applied:** Added `enable_test_clock: bool` to `CliOptions` (`apps/desktop/src/main.rs`) and `DesktopState` (`apps/desktop/src/server.rs`). Defaults to `false` in production; only enabled when `--enable-test-clock` or `CLOAK_ENABLE_TEST_CLOCK=1` is explicitly supplied (used by `tests/e2e/stealth-mode.spec.ts`). Production default now returns `403 FORBIDDEN` (`TEST_CLOCK_DISABLED`), verified by `stealth_locked_blocks_private_routes_until_secret_code_unlock`.

### [HIGH-02] Ordinary PDF Searches Incrementing Failed Auth Attempts & Lockout (FIXED)
- **Prior Behavior:** `apps/web/src/components/pdf/PdfReaderShell.tsx` submitted every Enter press in the PDF search bar to `POST /p2p/v1/stealth/unlock` (`method: 'pdf_search'`), and `crates/cloak-p2p/src/stealth_controller.rs` incremented the persistent `stealth_rate_limit.failed_attempts` counter in SQLite for every non-matching query. Searching 3 ordinary words not matching a secret code locked out all unlock pathways (including `Passphrase` and `PIN`).
- **Fix Applied:**
  1. `PdfReaderShell.tsx` now executes in-document PDF text search (`runDocumentSearch`) first; queries matching >= 1 occurrence inside the open PDF handle normal pagination locally without calling `/p2p/v1/stealth/unlock`. Previously probed non-matching strings in the session are cached in memory (`triedNonDocUnlockProbesRef`) so repeated Enter submits do not re-probe.
  2. `stealth_controller.rs` separates passive `UnlockMethod::PdfSearch` misses from `stealth_rate_limit.failed_attempts`: ordinary search misses never increment explicit `failed_attempts` or lock out Passphrase/PIN/HiddenShortcut modals, while rapid brute-force bursts (`>= 8` non-matching `PdfSearch` probes in 120s) silently engage a 30s `PdfSearch` cooldown (`pdf_search_cooldown_until_ms`). Explicit unlock methods (`Passphrase`, `Pin`, `HiddenShortcutInput`, `DiscreetCommand`) keep the strict 3-attempt persistent SQLite exponential cooldown. Verified by `pdf_search_ordinary_queries_do_not_lockout_while_burst_throttles` and `tests/e2e/stealth-mode.spec.ts`.

### [MEDIUM-01] Unencrypted Attachment Blob Chunks at Rest (FIXED)
- **Prior Behavior:** While SQLite `messages.ciphertext_b64` used `XChaCha20-Poly1305` and room/identity secrets used DPAPI-protected `VaultSecretBox`, `crates/cloak-p2p/src/storage.rs` (`store_local_attachment`, `write_attachment_chunk`) wrote raw plaintext attachment chunks to `<data_dir>/blobs/<attachment_id>/chunk_*.bin`.
- **Fix Applied:** Added `VaultSecretBox::seal_bytes` and `VaultSecretBox::open_bytes` (`crates/cloak-p2p/src/crypto.rs`) using `CLKBLOB1` + 24-byte `XNonce` + `XChaCha20-Poly1305` keyed by the DPAPI-protected master key (`vault.dpapi`). All newly stored/received chunks are sealed on disk (verified by `attachment_chunks_are_sealed_at_rest_and_verified_on_read`), while `write_attachment_chunk` now rejects chunks for unregistered `attachment_id`s to prevent unauthenticated orphan disk writes.

### [MEDIUM-02] Cross-Author Conflict Overwrite & Unjoined Room `SyncRequest` (FIXED)
- **Prior Behavior:** `storage.rs::upsert_received_message` used `ON CONFLICT(id) DO UPDATE SET ciphertext_b64 = excluded.ciphertext_b64...` without verifying `sender_device_id` or `room_id` matched the existing row; `transport.rs::handle_inbound_frame` answered `WireFrame::SyncRequest { room_id, .. }` without first verifying local membership in `room_id`.
- **Fix Applied:** Restricted `ON CONFLICT(id)` updates in `storage.rs` with `WHERE messages.sender_device_id = excluded.sender_device_id AND messages.room_id = excluded.room_id`, and gated `SyncRequest` handling in `transport.rs` on `vault.get_room(&room_id).ok().flatten().is_some()`.

---

## 2. Residual / Architectural Limitations Documented Honestly (§6.C–G & Honest Encryption Scope)

1. **At-Rest SQLite Metadata & WebView2 Cache Scope (No SQLCipher):**
   - **Encrypted at rest via DPAPI (`vault.dpapi`) + `XChaCha20-Poly1305`:** Identity Ed25519/X25519 private keys, `rooms.room_key_b64`, all `messages.ciphertext_b64`, and (as of Phase 11) all `blobs/<id>/chunk_*.bin` attachment files.
   - **NOT SQLCipher-encrypted on disk:** SQLite metadata columns (`rooms.name`, `channels.name`, `peers.display_name`/`direct_addr`, `attachments.filename`/`sha256_hex`, `pdf_library.title`, `stealth_settings`, `outbox` envelope JSON), imported decoy PDFs (`pdfs/*.pdf`), and Edge WebView2 profile files (`<data_dir>/webview2/`) rely on Windows NTFS ACLs and OS full-disk encryption (BitLocker) rather than an encrypted SQLite pager.
2. **File Deletion vs. SSD Wear-Leveling:**
   - SQLite `PRAGMA secure_delete = ON` + `wal_checkpoint(TRUNCATE)` zeros freed SQLite pages cleanly, but deleted blob/PDF files use `std::fs::remove_dir_all` / `remove_file`; on modern SSDs with TRIM/wear-leveling, physical sector erasure cannot be guaranteed by user-space software alone.
3. **Mutual Inbound Onboarding Auto-Registration:**
   - `transport.rs::perform_authenticated_handshake` auto-inserts unknown inbound TCP peers into `peers` (`Peer <short>`) after Ed25519 signature verification so ticket-based onboarding works symmetrically. Unknown peers cannot decrypt room ciphertexts without the ticket's `room_key_b64` and cannot pull `SyncBatch` without knowing a local 128-bit UUID `room_id`, and pinned Ed25519 keys prevent later key substitution (`is_peer_allowed`). However, unsolicited `WebRtcSignal` or `RoomKeyRotation` frames from an arbitrary connected TCP peer on a known `room_id` remain a consideration for stricter room-scoped peer ACLs in a future hardening pass.
4. **Loopback Session Token Surface (`window.__CLOAK_SESSION_TOKEN__`):**
   - `apps/desktop/src/native_shell.rs` injects `window.__CLOAK_SESSION_TOKEN__` into the embedded WebView2 initialization script and `apps/desktop/src/main.rs` passes `#cloakToken=...` only when falling back to `--edge-app`. Loopback HTTP middleware enforces strict `Host` check (`127.0.0.1:<port>`), strict `Origin` check (`null` or loopback origin), and constant-time bearer/WS token verification (`subtle::ConstantTimeEq`).
5. **No `WipeAndResetDecoy` Secret-Code Action in Codebase:**
   - Audited `crates/cloak-p2p/src/stealth.rs` (`SecretCodeAction` enum): valid actions are `OpenMessenger`, `OpenConversation`, `OpenPrivacySettings`, `ReturnToPdf`, and `PanicLock`. No wipe-all destructive secret-code variant exists, preventing accidental one-keystroke history erasure from PDF search.
6. **Unlocked Window Title Synchronization Observation:**
   - During automated Win32 testing (`verify-native-gui.ps1`), minimizing and external Notepad focus loss reliably switched the HWND title from `Cloak` to `Document Reader`; when unlocking via raw `POST /p2p/v1/stealth/unlock` while PowerShell held foreground lock focus, the window remained locked to `FocusLoss` or retained `"Document Reader"` at that sample instant (`TitleUnlocked: Document Reader`). Live interactive clicking inside the WebView2 UI maintains foreground focus cleanly.

