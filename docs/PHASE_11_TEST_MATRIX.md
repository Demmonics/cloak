# Cloak Phase 11 — Complete Audit & Verification Test Matrix

- **Branch:** `recovery/p2p-desktop`
- **Version:** `0.1.0`
- **Target Platform:** Windows x86_64 (`cargo +stable-x86_64-pc-windows-gnu`)
- **Audit Scope:** Post-final-edit automated checks, native Win32/WebView2 OS checks, hardware media/capture verification, installer/uninstaller parity checks, and two-PC physical LAN gap tracking.

---

## 1. Automated Build, Lint & Unit/Integration Suites (Post-Final-Edit)

| Suite | Command | Scope | Result | Timing / Notes |
| --- | --- | --- | --- | --- |
| Rust Formatting | `cargo +stable-x86_64-pc-windows-gnu fmt --check` | Workspace Rust crates | **PASS** (Exit 0) | Run after final Rust edit |
| Rust Clippy | `cargo +stable-x86_64-pc-windows-gnu clippy -p cloak-p2p -p cloak-desktop --all-targets -- -D warnings` | `cloak-p2p`, `cloak-desktop`, `cloak_setup` | **PASS** (Exit 0, 0 warnings) | Zero compiler/Clippy warnings |
| Rust Unit & Integration | `cargo +stable-x86_64-pc-windows-gnu test -p cloak-p2p -p cloak-desktop -- --test-threads=1` | `cloak-p2p` (12) + `cloak-desktop` (2) + `cloak_setup` (0) | **PASS** (`14/14`) | `cloak-desktop`: `1.70s`; `cloak-p2p`: `23.55s` |
| TypeScript Typecheck | `npm run typecheck` | `@cloak/protocol`, `@cloak/crypto`, `@cloak/archive`, `@cloak/config`, `@cloak/ui`, `@cloak/web` | **PASS** (Exit 0) | Clean across all 6 workspaces |
| ESLint | `npm run lint` | `eslint apps packages tests` | **PASS** (Exit 0) | Clean after all `.ts`/`.tsx` edits |
| Vitest Unit Tests | `npm run test:unit` | `crypto.test.ts` (6), `archive.test.ts` (6), `ComposerAndExport.test.tsx` (3) | **PASS** (`15/15`) | `1.20s` across 3 files (non-fatal jsdom navigation stderr log in `ComposerAndExport.test.tsx`) |

### Detailed Rust Test Cases (`14/14` Passed)

- `cloak-desktop` (`2/2`):
  - `server::tests::desktop_embedded_ui_security_guard_and_two_instance_p2p_flow`
  - `server::tests::stealth_locked_blocks_private_routes_until_secret_code_unlock` (also verifies production default `403 FORBIDDEN` / `TEST_CLOCK_DISABLED` on `/p2p/v1/stealth/test-clock-advance`)
- `cloak-p2p` (`12/12`):
  - `stealth_tests::attachment_chunks_are_sealed_at_rest_and_verified_on_read` (verifies `CLKBLOB1` + `XChaCha20-Poly1305` sealing at rest)
  - `stealth_tests::pdf_search_ordinary_queries_do_not_lockout_while_burst_throttles`
  - `stealth_tests::pdf_validation_blocks_corrupt_files_and_persists_reader_metadata`
  - `stealth_tests::rate_limiting_persists_across_restarts_and_modal_guard_protects_work`
  - `stealth_tests::secret_codes_unicode_actions_multi_factor_recovery_and_no_plaintext`
  - `stealth_tests::timers_30s_60s_10m_cancel_on_return_overdue_restart_and_foreground_idle`
  - `tests::ghost_mode_clear_viewed_preserves_unread_remote_and_blocks_resurrection`
  - `tests::ghost_mode_full_wipe_suppression_peer_revocation_and_key_pinning`
  - `tests::ghost_timed_disappear_restart_recovery_and_zero_dh_rejection`
  - `tests::offline_outbox_flushes_when_peer_comes_online`
  - `tests::strict_direct_only_reports_explicit_failure_without_relay`
  - `tests::two_peers_direct_encrypted_messaging_edit_delete_file_and_webrtc_signal`

---

## 2. Playwright E2E Verification

| Suite | Command | Result | Scope & Observations |
| --- | --- | --- | --- |
| P2P Desktop + Stealth E2E | `npx playwright test tests/e2e/p2p-desktop.spec.ts tests/e2e/stealth-mode.spec.ts --reporter=list` | **PASS** (`4/4`, `33.5s`) | Spawns real headless `cloak-desktop.exe` instances (`--enable-test-clock` for timer tests). Covers loopback auth guard, `DirectOnly` pairing, search/export/attachments, Ghost Mode PIN/Clear Viewed/Clear Open/non-resurrection, 2-peer WebRTC media + screen share, and full Stealth Mode lifecycle + ordinary PDF search non-lockout. |
| Legacy Server-Mode E2E (`cloak.spec.ts`) | `npx playwright test` (prior full run) | **FAIL (Out-of-Scope Environment)** (`3 passed, 2 failed`) | `tests/e2e/cloak.spec.ts` targets the legacy browser/Postgres/Vite server app at `http://127.0.0.1:4173/`, failing with `ERR_CONNECTION_REFUSED` when running standalone P2P desktop tests without launching that server stack. |

---

## 3. Native Windows GUI, Win32 Lifecycle & Memory Verification

Executed against windowed `cloak-desktop.exe` (Win32 HWND + WebView2) via `verify-native-gui.ps1`:

- **Startup Timing:**
  - `HttpReadyMs`: `1187.3 ms`
  - `HwndReadyMs`: `1202 ms`
  - `SettledGuiMs`: `3705.7 ms`
- **Process Tree Memory (Native GUI + WebView2):**
  - `WebViewChildCount`: `8` child processes
  - `RustProcessWorkingSetMiB`: `49.5 MiB`
  - `WebViewChildrenWsMiB`: `482.61 MiB`
  - **`TotalTreeWorkingSetMiB`**: `532.11 MiB`
  - **`TotalTreePrivateMemMiB`**: `270.98 MiB`
- **Win32 Window & Display Affinity:**
  - `TitleInitial`: `"Cloak"`
  - `TitleLocked`: `"Document Reader"`
  - `TitleUnlocked`: `"Document Reader"` (window title sync limitation after unlock; documented in [PHASE_11_SECURITY_FINDINGS.md](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/PHASE_11_SECURITY_FINDINGS.md))
  - `AffinityInitialHex`: `0x0`
  - `AffinityProtectedHex`: `0x11` (`WDA_EXCLUDEFROMCAPTURE` active)
- **OS Lifecycle Triggers:**
  - `MinimizedIconic`: `True`
  - `LockedAfterMinimize`: `True`
  - `LockedStayedAfterRestore`: `True` (`pdf_reader`)
  - `UnlockMatched`: `True`
  - `LockedAfterExternalFocus` (switching focus to Notepad): `True`
  - `LockedAfterCrashRestart`: `True`
  - `RemainingMsgCountAfter4sAway`: `1` (`"Unread msg preserved"`)

### Headless Reference Benchmark (`scripts/bench-desktop.ps1`, Pre-`capture.rs` Patch)

Recorded on the workspace build prior to the final `capture.rs` GDI fix (desktop P2P + SQLite transport paths unchanged afterward):

- `ReleaseBinarySizeMiB`: `20.94 MiB` (matches final `cloak-desktop.exe` size)
- `NativeGuiHttpReadyMs`: `1572.3 ms`
- `HeadlessStartupMs`: `1063.1 ms`
- `HeadlessIdleRamMiB`: `14.75 MiB`
- `FiftyMsgsEndToEndMs`: `354.1 ms` (`50` messages)
- `TwoMiBFileTransferMs`: `892 ms` (`2097152` bytes)

---

## 4. Real-Device Media & Native Win32 Screen Capture Verification

- **Real Hardware Audio/Video (`verify-hardware-media.mjs` in Chromium):**
  - Enumerated `32` real/virtual devices (`13` `audioinput`, `7` `videoinput`, `12` `audiooutput`).
  - Acquired active `getUserMedia` tracks: `Lenovo Virtual Camera` (`1280x720@30fps`) + `Microphone (2- EDIFIER W820NB Plus)` (`48000 Hz`, `16-bit`, AEC/AGC/NS, `latency: 0.01`).
  - Verified peer call banners & state (`Direct WebRTC · Video + Audio ICE: connected`).
- **Native Win32 GDI Window/Monitor Capture Benchmark (`probe-capture.mjs`):**
  - `win:528920` (`Cloak` `1618x1072`, `maxWidth=1280`): `4198454 bytes` (`4.00 MiB`), `avg = 42.41 ms` (`23.6 fps`)
  - `win:528920` (`Cloak` `1618x1072`, `maxWidth=1920`): `6560054 bytes` (`6.26 MiB`), `avg = 44.38 ms` (`22.5 fps`)
  - `mon:0` (`Display 1 1920x1080`) during locked Windows session: `404 StretchBlt failed capturing screen region (desktop locked or protected?)` (explicitly reported rather than silently returning black frames).

---

## 5. Windows Packaging, Installer & Uninstaller Parity (Post-Final-Build)

Packaged via `scripts/package-windows.ps1` and tested silently via `verify-installer.ps1`:

- **Build Artifacts (`dist-windows/`):**
  - `cloak-desktop.exe`: `20.94 MiB` (`SHA256: 64056C7276BBFACE4605EEC5D0F3194EED5E0199F76D81DA3F4A2B9C81EA21DD`)
  - `Cloak-Setup-x64.exe`: `22.26 MiB` (`SHA256: 1110FF75CD3E50DD1E991FC3C9581E779B0C2B4ADB7CF5EB305AAD737381B34D`)
  - `Cloak-Portable-win64.zip`: `6.71 MiB` (`SHA256: 4766A53AD3C0188703A574AE1C3002CAE44DA39A55068E883F5B9A5FAABDF54F`)
- **Silent Install & Uninstall Matrix:**
  - `InstallerExitCode`: `0`
  - `InstalledExeExists`: `True`
  - `InstalledUninstallerExists`: `True` (`uninstall.exe`)
  - `Sha256ParityMatch`: `True`
  - `DisplayName`: `"Cloak (Local-First P2P Messenger)"` (`DisplayVersion: "0.1.0"`, `Publisher: "Cloak Privacy"`)
  - `StartMenuShortcutCreated`: `True`
  - `DesktopShortcutCreated`: `True`
  - `InstalledBinaryBootOk`: `True`
  - `UninstallerExitCode`: `0`
  - `DesktopExeRemovedOnUninst` / `StartLnkRemovedOnUninst` / `DeskLnkRemovedOnUninst` / `RegEntryRemovedOnUninst`: All `True`

---

## 6. Network & Hardware Tests — Pending Physical Hardware

Only a single physical Windows machine (`YOOSHA`) is present in this environment. Loopback multi-peer P2P, WebRTC signaling, and Windows Firewall readiness (`scripts/two-pc-lan-qa.ps1 -Role CheckOnly`: Host `YOOSHA`, LAN IPv4s `192.168.56.1, 172.17.16.64, 100.73.157.26, 192.168.29.241`, Firewall `Present (6 rule(s) matching *Cloak*)`) were verified, while physical cross-machine tests remain **Pending Physical Hardware**:

| Scenario | Status | Instructions to Complete |
| --- | --- | --- |
| Physical Two-PC LAN Pairing & E2E Messaging | **Pending Physical Hardware** | Run `scripts/two-pc-lan-qa.ps1` across two Windows PCs on the same LAN (`Host` on PC 1, `Guest` on PC 2). |
| Physical Two-PC File Transfer, Resync & Offline Outbox Flush | **Pending Physical Hardware** | Verify large file transfer, peer disconnect, queued outbox messages, and reconnect sync between PC 1 and PC 2. |
| Physical Two-PC Voice/Video & Screen Share over LAN/WAN | **Pending Physical Hardware** | Verify `ICE: connected`, bidirectional audio/video, and live screen share across distinct physical NICs / NATs. |

